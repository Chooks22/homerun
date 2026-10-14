import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	config,
	isPlaceholderAuthSecret,
	isSmtpEnabled,
	serviceDomain,
} from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { db } from "#lib/server/db/lib.js";
import { user as userTable } from "#lib/server/db/schema.js";
import { WorkerClient } from "#lib/server/worker-client.js";
import { dev } from "$app/env";
import { traefikExpectation } from "./cron/core-services-watch.ts";
import { DASHBOARD_ROUTER_FILE } from "./docker/dashboard.ts";
import { hasTraefikRouterFor } from "./docker/labels.ts";
import { type WedgedContainer, wedgedMessage } from "./docker/wedged.ts";
import { DockerService } from "./docker.service.ts";

export interface SetupCheck {
	/** A fix the dashboard can run in one click, instead of a settings field to edit. */
	action?: "reapply-traefik";
	detail: string;
	envVar?: string;
	id: string;
	label: string;
	severity: "ok" | "warn" | "danger";
}

/** Instance-level admin operations: setup diagnostics and bootstrap-state checks. */
class AdminServiceClass {
	/**
	 * Maps a check's id to the `/settings` field id(s) it corresponds to, so
	 * the dashboard banner can deep-link straight to (and highlight) the
	 * offending field instead of just linking to the page in general.
	 * "auth-secret" (env only, no /settings field) and "traefik" (a live
	 * container check, not a form input) are deliberately absent : nothing
	 * to highlight for either.
	 */
	readonly SETUP_CHECK_FIELDS: Record<string, string[]> = {
		// "origin" doesn't have its own input any more : it's derived from
		// baseDomain + the Use HTTPS toggle right next to it (General
		// section of /settings), so both checks point at the same field.
		"base-domain": ["baseDomain"],
		"dashboard-router": ["traefikDynamicConfigDir"],
		docker: ["dockerSocketPath"],
		origin: ["baseDomain"],
		smtp: ["smtpHost", "smtpPort", "smtpUser", "smtpPassword", "smtpFrom"],
	};

	/**
	 * Whether any account exists at all yet. Drives two things: the very first
	 * account created (via public sign-up) becomes the instance's admin (see
	 * auth.ts's databaseHooks), and public sign-up itself locks once this is
	 * true (see hooks.server.ts) : every account after the first is created by
	 * an admin, from the Users page.
	 *
	 * Raw query against `user` rather than a DTO : there's no DTO for
	 * better-auth-owned tables, same precedent hooks.server.ts already uses for
	 * the API-key lookup below.
	 */
	async hasAnyUser(): Promise<boolean> {
		const [row] = await db
			.select({ id: userTable.id })
			.from(userTable)
			.limit(1);
		return !!row;
	}

	/**
	 * Lightweight diagnostics for "is this instance actually configured".
	 * `config` here already reflects DB-backed instance settings merged over
	 * env defaults (see $lib/config.ts's applyInstanceSettings() and the
	 * /settings page) : these checks just report the effective value, they
	 * don't care which layer it came from. `envVar` is still worth showing:
	 * it's the env-var equivalent for anyone bootstrapping via docker-compose
	 * before ever visiting /settings. Still no DNS/SSL-provider automation
	 * flow : out of scope here, see TODO.md's Onboarding section.
	 */
	async runSetupChecks(): Promise<SetupCheck[]> {
		const checks: SetupCheck[] = [
			this.#baseDomainCheck(),
			this.#authSecretCheck(),
			this.#originCheck(),
			await this.#traefikCheck(),
			await this.#dockerCheck(),
		];
		const wedged = await this.#wedgedCheck();
		if (wedged) {
			checks.push(wedged);
		}
		const traefikConfig = await this.#traefikConfigCheck();
		if (traefikConfig) {
			checks.push(traefikConfig);
		}

		const dashboardHost = this.#dashboardHost();
		if (dashboardHost) {
			const routing = await this.#dashboardRouterCheck(dashboardHost);
			if (routing) {
				checks.push(routing);
			}
		}

		if (config.smtp.enabled) {
			checks.push(this.#smtpCheck());
		}

		return checks;
	}

	/** Warns when `baseDomain` is still the `localhost` default outside dev, since deployed services would only be reachable from this machine. */
	#baseDomainCheck(): SetupCheck {
		if (config.baseDomain === "localhost" && !dev) {
			return {
				detail:
					"Deployed services will only be reachable at <slug>.localhost from this machine : set a real domain for public routing (env var below, or the Core section of /settings).",
				envVar: "BASE_DOMAIN",
				id: "base-domain",
				label: "Base domain",
				severity: "warn",
			};
		}
		return {
			detail: `Services are routed under <slug>.${serviceDomain()}.`,
			id: "base-domain",
			label: "Base domain",
			severity: "ok",
		};
	}

	/** Flags a missing, blank or built-in placeholder auth secret as a danger-severity finding outside dev, since it means sessions aren't safe against a compromised install. */
	#authSecretCheck(): SetupCheck {
		if (isPlaceholderAuthSecret(config.auth.secret) && !dev) {
			return {
				detail:
					"No real auth secret is set (AUTH_SECRET is empty or unset), so the built-in placeholder is in use : sessions aren't safe against a compromised install. Generate a real one (e.g. `openssl rand -base64 32`).",
				envVar: "AUTH_SECRET (or BETTER_AUTH_SECRET)",
				id: "auth-secret",
				label: "Auth secret",
				severity: "danger",
			};
		}
		return {
			detail: "A non-default auth secret is set.",
			id: "auth-secret",
			label: "Auth secret",
			severity: "ok",
		};
	}

	/** Warns when no origin is configured outside dev, since it's then derived per-request, which can misbehave behind a proxy. */
	#originCheck(): SetupCheck {
		if (config.auth.origin || dev) {
			return {
				detail: `Dashboard URL set to ${config.auth.origin}.`,
				id: "origin",
				label: "Dashboard URL",
				severity: "ok",
			};
		}
		return {
			detail:
				"No Dashboard URL configured : derived per-request for now, which is fine for a single domain but can misbehave behind a proxy. Set a Base domain (env var below, or the General section of /settings) to pin it.",
			envVar: "ORIGIN",
			id: "origin",
			label: "Dashboard URL",
			severity: "warn",
		};
	}

	/** The dashboard's hostname derived from the configured origin, or null if there's no origin or it carries an explicit port (routing checks below don't apply to a bare `host:port` origin). */
	#dashboardHost(): string | null {
		if (!config.auth.origin) {
			return null;
		}
		try {
			const url = new URL(config.auth.origin);
			return url.port ? null : url.hostname;
		} catch {
			return null;
		}
	}

	/**
	 * Whether something actually routes `host` to this container: the router
	 * file Homerun publishes to the Traefik dynamic config directory
	 * (`DASHBOARD_ROUTER_FILE`, the one that survives a stalled Docker
	 * provider), or else a Traefik router label on it. Returns null (no check
	 * to show) if this container's own labels can't be read at all.
	 */
	async #dashboardRouterCheck(host: string): Promise<SetupCheck | null> {
		const labels = await DockerService.selfContainerLabels().catch(() => null);
		if (!labels) {
			return null;
		}
		const dir = config.traefik.dynamicConfigDir;
		if (dir && existsSync(join(dir, DASHBOARD_ROUTER_FILE))) {
			return {
				detail: `Traefik routes ${host} to this container through the dynamic config file Homerun publishes, which keeps working even when Traefik's Docker provider stalls.`,
				id: "dashboard-router",
				label: "Dashboard routing",
				severity: "ok",
			};
		}
		if (hasTraefikRouterFor(labels, host)) {
			return {
				detail: `This container carries a Traefik router for ${host}. Set the Traefik dynamic config directory under Settings → Networking too, so the dashboard stays reachable when Traefik's Docker provider stalls.`,
				id: "dashboard-router",
				label: "Dashboard routing",
				severity: "ok",
			};
		}
		return {
			detail: `Nothing routes ${host} to this container, so the dashboard answers only on its published port and Traefik returns 404 (and serves no certificate) for that hostname. Either set the Traefik dynamic config directory under Settings → Networking so Homerun publishes a router for it, or add Traefik labels to this service in its compose file (the installer generates them from DASHBOARD_DOMAIN) and recreate the container.`,
			envVar: "DASHBOARD_DOMAIN",
			id: "dashboard-router",
			label: "Dashboard routing",
			severity: "warn",
		};
	}

	/** Whether a Traefik container is currently running on this host, checked via `DockerService.findTraefikContainer`. */
	async #traefikCheck(): Promise<SetupCheck> {
		const traefik = await DockerService.findTraefikContainer().catch(
			() => null,
		);
		if (traefik) {
			return {
				detail: `Found running as ${traefik.name}.`,
				id: "traefik",
				label: "Traefik ingress",
				severity: "ok",
			};
		}
		return {
			detail:
				"No running Traefik container found : deployed services won't get public routing/TLS until it's started (see compose.yaml).",
			id: "traefik",
			label: "Traefik ingress",
			severity: "warn",
		};
	}

	/**
	 * Whether the running Traefik still has the flags the settings put on it
	 * (the swarm provider, the HTTP cache plugin, the ACME email). Recreating
	 * it from the compose file drops them: with the cache on, every cached
	 * service then answers 404. Null when there's no Traefik or the worker
	 * can't be asked, which other checks already report.
	 */
	async #traefikConfigCheck(): Promise<SetupCheck | null> {
		const settings = await InstanceSettingsDTO.get();
		const missing = await DockerService.traefikDrift(
			traefikExpectation(settings.orchestrationMode === "swarm"),
		).catch(() => null);
		if (!missing) {
			return null;
		}
		if (missing.length === 0) {
			return {
				detail: "Running with every flag the settings call for.",
				id: "traefik-config",
				label: "Traefik configuration",
				severity: "ok",
			};
		}
		return {
			action: "reapply-traefik",
			detail: `Traefik is running without ${missing.join(", ")}, probably recreated from the compose file. Services that depend on it won't route until it's re-applied.`,
			id: "traefik-config",
			label: "Traefik configuration",
			severity: "danger",
		};
	}

	/**
	 * Whether Docker is actually reachable, which now means two things in a
	 * row: the worker answers at all, and the daemon answers the worker.
	 *
	 * They're reported apart on purpose. The app holds no Docker socket any
	 * more, so "nothing deploys" has two quite different causes with two quite
	 * different fixes, and collapsing them into one "Docker socket" line sent
	 * the operator to check a socket the app doesn't even open.
	 */
	async #dockerCheck(): Promise<SetupCheck> {
		const workerUp = await WorkerClient.get("/v1/health")
			.then(() => true)
			.catch(() => false);
		if (!workerUp) {
			return {
				detail: `Couldn't reach the Homerun worker at ${WorkerClient.baseUrl} : it's the process that talks to Docker, so nothing will deploy, no container status will refresh and the terminal won't open until it's running.`,
				envVar: "WORKER_URL",
				id: "docker",
				label: "Homerun worker",
				severity: "danger",
			};
		}
		const dockerOk = await WorkerClient.get("/v1/info")
			.then(() => true)
			.catch(() => false);
		if (dockerOk) {
			return {
				detail: "Connected.",
				id: "docker",
				label: "Docker socket",
				severity: "ok",
			};
		}
		return {
			detail: `The worker is up but Docker isn't answering it at ${config.docker.socketPath} : nothing will deploy until this is fixed (env var below, set on the worker).`,
			envVar: "DOCKER_SOCKET_PATH",
			id: "docker",
			label: "Docker socket",
			severity: "danger",
		};
	}

	/**
	 * Whether the worker's janitor found helper containers the Docker daemon
	 * is wedged on (inspect and remove hang), which only a Docker restart
	 * clears. Null when there are none or the worker can't be asked.
	 */
	async #wedgedCheck(): Promise<SetupCheck | null> {
		const health = await WorkerClient.get<{
			wedgedContainers?: WedgedContainer[];
		}>("/v1/health").catch(() => null);
		const message = wedgedMessage(health?.wedgedContainers ?? []);
		if (!message) {
			return null;
		}
		return {
			detail: message,
			id: "docker-wedged",
			label: "Docker daemon stuck",
			severity: "danger",
		};
	}

	/** Whether SMTP is fully configured (`isSmtpEnabled`), given it's already been turned on. */
	#smtpCheck(): SetupCheck {
		if (isSmtpEnabled()) {
			return {
				detail: `Configured via ${config.smtp.host}.`,
				id: "smtp",
				label: "Email (SMTP)",
				severity: "ok",
			};
		}
		return {
			detail:
				"SMTP is enabled but one or more of host/port/user/password/from is missing : email verification won't work (env vars below, or the SMTP section of /settings).",
			envVar: "SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM",
			id: "smtp",
			label: "Email (SMTP)",
			severity: "danger",
		};
	}
}

export const AdminService = new AdminServiceClass();
