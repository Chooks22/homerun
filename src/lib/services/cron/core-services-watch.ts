import { dnsChallengeSetup } from "#lib/acme-dns.js";
import {
	applyInstanceSettings,
	config,
	setDetectedAuthCheckUrl,
} from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import { WorkerClient } from "#lib/server/worker-client.js";
import { AcmeDnsService } from "../acme-dns.service.ts";
import { DeploymentService } from "../deploy.service.ts";
import { syncCoreHostDns, syncDashboardDns } from "../dns.service.ts";
import type { TraefikExpectation } from "../docker/core-services.ts";
import { syncErrorPages } from "../docker/error-pages.ts";
import { type WedgedContainer, WedgedReporter } from "../docker/wedged.ts";
import { DockerService } from "../docker.service.ts";
import { ObjectStorageService } from "../object-storage.service.ts";
import { AUTH_CHECK_ALIAS } from "../self-update/compose-target.ts";
import { StatusPageSettingsService } from "../status-page-settings.service.ts";
import { TracingService } from "../tracing.service.ts";
import { BaseScheduler } from "./base-scheduler.ts";

const TICK_MS = 15_000;

/**
 * Points the login wall's forwardAuth at this dashboard on the Docker network
 * (unless the config file pins the URL), then re-applies the instance
 * settings so it takes effect. Uses the `homerun-auth` network alias when the
 * container has it, which the self-updater's candidate takes over while the
 * app container is swapped, so gated sites keep answering during an update;
 * the container's own name otherwise. Asks the worker, so it does nothing
 * while the worker isn't reachable; the core-services watch calls it again
 * once it is.
 *
 * @returns Whether the dashboard's container was found.
 */
export async function detectAuthCheckUrl(): Promise<boolean> {
	const self = await DockerService.selfContainer().catch(() => null);
	if (!(self?.name && self.networkAddress)) {
		return false;
	}
	const host = self.aliases.includes(AUTH_CHECK_ALIAS)
		? AUTH_CHECK_ALIAS
		: self.name;
	setDetectedAuthCheckUrl(`http://${host}:${config.port}/api/v1/auth-check`);
	const settings = await InstanceSettingsDTO.get();
	applyInstanceSettings(settings.toConfigOverride());
	return true;
}

/** What the running Traefik should be configured with, from the effective settings. */
export function traefikExpectation(swarm: boolean): TraefikExpectation {
	return {
		acmeEmail: config.traefik.acmeEmail ?? null,
		certResolver: config.traefik.certResolver,
		dnsChallenge:
			config.traefik.dnsChallengeDomains.length > 0 && !config.pangolinEnabled
				? dnsChallengeSetup(config.authCheckUrl, config.auth.secret)
				: null,
		httpCache: config.traefik.httpCache,
		swarm,
	};
}

export class CoreServicesWatch extends BaseScheduler {
	protected readonly label = "CoreServices";

	protected readonly intervalMs = TICK_MS;

	protected readonly runOnStart = true;

	#bootId: string | null = null;

	readonly #wedged = new WedgedReporter();

	/**
	 * Polls the worker's health and, whenever its boot id differs from the
	 * last one seen (the first successful contact included), re-asserts the
	 * core services onto it: the forward-auth URL detection, the dashboard's
	 * Traefik router and DNS record, the Newt tunnel, the published
	 * registry's Traefik labels, swarm mode when
	 * that's the orchestration mode, and the Traefik flags Settings →
	 * Networking adds (the HTTP cache plugin, the ACME email), which a
	 * `docker compose up --force-recreate` or a self-update wipes by
	 * recreating Traefik from the compose file. So a
	 * worker restarted alone, or one that wasn't up yet when the app booted,
	 * still ends up converged. An unreachable worker is skipped silently and
	 * retried next tick; a failed convergence step is logged, not retried
	 * until the next worker restart. Every tick also reports helper
	 * containers the worker found Docker wedged on, once each, as a
	 * notification.
	 */
	protected async tick(): Promise<void> {
		const health = await WorkerClient.get<{
			bootId?: string;
			wedgedContainers?: WedgedContainer[];
		}>("/v1/health").catch(() => null);
		if (health) {
			this.#wedged.report(health.wedgedContainers ?? [], (message) => {
				this.logger.warn(message);
				NotificationDTO.notify({ message, type: "docker_wedged" });
			});
		}
		const bootId = health?.bootId;
		if (!bootId || bootId === this.#bootId) {
			return;
		}
		this.logger.info(
			this.#bootId
				? "Worker restarted, re-asserting the core services"
				: "Worker reachable, asserting the core services",
		);
		this.#bootId = bootId;
		if (await detectAuthCheckUrl()) {
			void DeploymentService.redeployStaleLoginWalls().catch((err) => {
				this.logger.warn("Couldn't check for stale login-wall routing", err);
			});
		}
		const settings = await InstanceSettingsDTO.get();
		await AcmeDnsService.load().catch((err) => {
			this.logger.warn("Couldn't load the DNS challenge domains", err);
		});
		await AcmeDnsService.syncRouters();
		await DockerService.syncDashboardRouter();
		await syncErrorPages();
		await StatusPageSettingsService.syncRoutes();
		void syncDashboardDns();
		await DockerService.syncNewt(
			settings.newtCredentials(),
			settings.orchestrationMode === "swarm",
		);
		const registryHost = settings.toJSON().registryPublicHost;
		if (registryHost) {
			await DockerService.ensureImageMirror().catch((err) => {
				this.logger.warn("Couldn't re-assert the published registry", err);
			});
			void syncCoreHostDns("Registry", null, registryHost);
		}
		await ObjectStorageService.reassertBuiltin().catch((err) => {
			this.logger.warn("Couldn't re-assert the built-in object store", err);
		});
		await TracingService.reassertCollector().catch((err) => {
			this.logger.warn("Couldn't re-assert the OpenTelemetry collector", err);
		});
		const failures = await DockerService.reassertTraefikConfig(
			traefikExpectation(settings.orchestrationMode === "swarm"),
		);
		for (const failure of failures) {
			this.logger.warn(
				`Couldn't re-assert the Traefik configuration: ${failure}`,
			);
		}
	}
}
