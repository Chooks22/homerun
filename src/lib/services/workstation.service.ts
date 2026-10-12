import dns from "node:dns/promises";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "#lib/config.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { WorkerClient } from "#lib/server/worker-client.js";
import {
	AgentClientService,
	type AgentConnection,
} from "#lib/services/agent-client.service.js";
import { resolveGitCredential } from "#lib/services/deploy/helpers.js";
import { deleteDns, syncDns } from "#lib/services/dns.service.js";
import {
	agentHostAddress,
	workstationLabels,
	workstationRouteFile,
	workstationRouteYaml,
} from "#lib/services/workstation/routing.js";
import {
	containerCheck,
	routeCheck,
	type WorkstationCheck,
} from "#lib/workstation-self-test.js";
import {
	type AutoStopMode,
	autoStopStep,
	repoDirectory,
	type WorkstationStatus,
	workstationHostname,
} from "#lib/workstations.js";

const logger = new Logger("Workstation");

const CERT_ERROR_RE = /certificate|cert_|self[- ]signed|verify/i;

/** An error's message, whatever was thrown. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type Target =
	| { kind: "local" }
	| { address: string; connection: AgentConnection; kind: "agent" };

/** The container spec the worker's or agent's workstation routes take. */
export interface WorkstationSpec {
	env: Record<string, string>;
	git: {
		branch: string;
		directory: string;
		token: string;
		url: string;
		username: string;
	} | null;
	homePath: string;
	image: string;
	labels: Record<string, string>;
	memoryBytes: number;
	name: string;
	nanoCpus: number;
	network: string;
	port: number;
	publish: boolean;
}

/** A workstation's live status plus where to open it. */
export interface WorkstationView {
	autoStopAt: Date | null;
	status: WorkstationStatus;
	url: string | null;
}

/**
 * Runs dev workstations on this server (through the local worker) or on an
 * agent-mode remote host (through its own API), and keeps their Traefik route
 * in step: Docker labels locally, a file-provider route for an agent host.
 */
class WorkstationServiceClass {
	/**
	 * Where `ws` runs.
	 *
	 * @throws When its remote host is gone or isn't a usable agent.
	 */
	async #target(ws: WorkstationDTO): Promise<Target> {
		if (!ws.remoteHostId) {
			return { kind: "local" };
		}
		const host = await RemoteHostDTO.get(ws.remoteHostId);
		const connection = host?.toAgentConnection();
		if (!connection) {
			throw new Error(
				"This workstation's host isn't a registered agent any more.",
			);
		}
		return {
			address: agentHostAddress(connection.agentUrl),
			connection,
			kind: "agent",
		};
	}

	/** Sends one workstation call to the local worker or the agent. */
	#call<T>(
		target: Target,
		method: "DELETE" | "GET" | "POST" | "PUT",
		path: string,
		options?: { body?: unknown; query?: Record<string, string> },
	): Promise<T> {
		if (target.kind === "agent") {
			return AgentClientService.request<T>(
				target.connection,
				method,
				path,
				options,
			);
		}
		switch (method) {
			case "GET":
				return WorkerClient.get<T>(path, options?.query);
			case "PUT":
				return WorkerClient.put<T>(path, options?.body);
			case "POST":
				return WorkerClient.post<T>(path, options?.body, options?.query);
			default:
				return WorkerClient.delete<T>(path, options?.query);
		}
	}

	/** The `<slug>.<baseDomain>` hostname `ws` is routed at. */
	hostname(ws: WorkstationDTO): string {
		return workstationHostname(ws.slug, config.baseDomain);
	}

	/**
	 * Everything the worker or agent needs to run `ws`: its password in env,
	 * its git repository with the owner's provider credential, and either
	 * Traefik labels on this server's network or a published port on an agent.
	 *
	 * @throws When the stored password can't be decrypted.
	 */
	async #spec(ws: WorkstationDTO, target: Target): Promise<WorkstationSpec> {
		const row = ws.toJSON();
		const password = ws.password();
		if (!password) {
			throw new Error(
				"Couldn't decrypt this workstation's password. Reset it under Settings.",
			);
		}
		const credential = row.gitUrl
			? await resolveGitCredential(row.gitUrl, row.userId)
			: null;
		const local = target.kind === "local";
		return {
			env: { ...row.env, PASSWORD: password },
			git: row.gitUrl
				? {
						branch: row.gitBranch ?? "",
						directory: repoDirectory(row.gitUrl),
						token: credential?.token ?? "",
						url: row.gitUrl,
						username: credential?.username ?? "",
					}
				: null,
			homePath: row.homePath,
			image: row.image,
			labels: local
				? workstationLabels(ws.slug, this.hostname(ws), row.port)
				: {},
			memoryBytes: (row.memoryLimitMb ?? 0) * 1024 * 1024,
			name: `homerun-ws-${ws.slug}`,
			nanoCpus: Math.round((row.cpuLimit ?? 0) * 1e9),
			network: local ? config.docker.networkName : "",
			port: row.port,
			publish: !local,
		};
	}

	/**
	 * Starts `ws`, recreating its container from the current settings. The
	 * home volume survives. Answers once the start is under way.
	 *
	 * @throws When the worker or agent refuses or can't be reached; the
	 *   message is also stored as the workstation's last error.
	 */
	async start(ws: WorkstationDTO): Promise<void> {
		try {
			const target = await this.#target(ws);
			const spec = await this.#spec(ws, target);
			await this.#call(target, "PUT", `/v1/workstations/${ws.id}`, {
				body: spec,
			});
			await ws.update({
				autoStopAt: this.#deadline(ws),
				desiredState: "running",
				lastError: null,
			});
			logger.info(`Workstation starting: workstation=${ws.id}`);
			await this.#syncDns(ws);
		} catch (error) {
			await ws.update({
				lastError: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * Stops `ws`, keeping its container and home volume.
	 *
	 * @throws When the worker or agent refuses or can't be reached.
	 */
	async stop(ws: WorkstationDTO): Promise<void> {
		const target = await this.#target(ws);
		await this.#call(target, "POST", `/v1/workstations/${ws.id}/stop`);
		await ws.update({ autoStopAt: null, desiredState: "stopped" });
		await this.#removeRoute(ws);
		logger.info(`Workstation stopped: workstation=${ws.id}`);
	}

	/** When `ws` auto-stops if it starts now, null when its auto-stop is off. */
	#deadline(ws: WorkstationDTO, now = new Date()): Date | null {
		const { autoStopMinutes, autoStopMode } = ws.toJSON();
		return autoStopMode && autoStopMinutes
			? new Date(now.getTime() + autoStopMinutes * 60_000)
			: null;
	}

	/**
	 * Saves `ws`'s auto-stop setting, `mode` null turning it off. A running
	 * workstation's countdown restarts from now; a stopped one arms it on its
	 * next start.
	 */
	async setAutoStop(
		ws: WorkstationDTO,
		mode: AutoStopMode | null,
		minutes: number | null,
	): Promise<void> {
		const autoStopMinutes = mode ? minutes : null;
		await ws.update({
			autoStopAt:
				mode && autoStopMinutes && ws.desiredState === "running"
					? new Date(Date.now() + autoStopMinutes * 60_000)
					: null,
			autoStopMinutes,
			autoStopMode: mode,
		});
		logger.info(
			`Workstation auto-stop set: workstation=${ws.id} mode=${mode ?? "off"} minutes=${minutes ?? 0}`,
		);
	}

	/**
	 * How many connections `ws`'s IDE port holds open inside its container.
	 *
	 * @throws When it isn't running, is still starting, or the worker or agent
	 *   can't read it.
	 */
	async connections(ws: WorkstationDTO): Promise<number> {
		const target = await this.#target(ws);
		const answer = await this.#call<{ connections: number }>(
			target,
			"GET",
			`/v1/workstations/${ws.id}/connections`,
			{ query: { port: String(ws.toJSON().port) } },
		);
		return answer.connections;
	}

	/**
	 * One auto-stop pass over `ws`: in idle mode an open connection pushes the
	 * deadline out (as does a connection count it can't read, so a start in
	 * progress or an image without `cat` never counts as idle), and once the
	 * deadline passes the workstation is stopped.
	 *
	 * @throws When stopping it fails.
	 */
	async autoStop(ws: WorkstationDTO, now: Date): Promise<void> {
		const { autoStopAt, autoStopMinutes, autoStopMode } = ws.toJSON();
		if (!autoStopMode || !autoStopMinutes) {
			return;
		}
		const active =
			autoStopMode === "idle" &&
			(await this.connections(ws).then(
				(count) => count > 0,
				(error: unknown) => {
					logger.warn(
						`Couldn't read a workstation's connections, counting it as in use: workstation=${ws.id}`,
						error,
					);
					return true;
				},
			));
		const step = autoStopStep({
			active,
			autoStopAt,
			minutes: autoStopMinutes,
			mode: autoStopMode,
			now,
		});
		if (step.kind === "arm") {
			await ws.update({ autoStopAt: step.at });
		} else if (step.kind === "stop") {
			await this.stop(ws);
			logger.info(
				`Workstation auto-stopped: workstation=${ws.id} mode=${autoStopMode} minutes=${autoStopMinutes}`,
			);
		}
	}

	/**
	 * Removes `ws`'s container (and its home volume when `withVolume`), its
	 * route and its row.
	 *
	 * @throws When the worker or agent refuses or can't be reached; the row
	 *   is kept then, so nothing is orphaned silently.
	 */
	async remove(ws: WorkstationDTO, withVolume: boolean): Promise<void> {
		const target = await this.#target(ws);
		await this.#call(target, "DELETE", `/v1/workstations/${ws.id}`, {
			query: { volume: withVolume ? "1" : "0" },
		});
		await this.#removeRoute(ws);
		await deleteDns([this.hostname(ws)]);
		await ws.delete();
		logger.info(
			`Workstation removed: workstation=${ws.id} volume=${withVolume}`,
		);
	}

	/**
	 * Removes every workstation `userId` owns, volumes included, before the
	 * account goes. A failure is logged and skipped: the rows cascade anyway.
	 */
	async removeAllFor(userId: string): Promise<void> {
		const owned = await WorkstationDTO.listForUser(userId);
		await Promise.all(
			owned.map((ws) =>
				this.remove(ws, true).catch((error: unknown) => {
					logger.warn(
						`Couldn't remove a workstation of a deleted user: workstation=${ws.id}`,
						error,
					);
				}),
			),
		);
	}

	/**
	 * `ws`'s live status and the URL to open it at. For an agent-hosted
	 * workstation this also writes (or drops) its file-provider route, since
	 * the published port is only known once it runs; without a dynamic config
	 * directory the URL is the agent's published port itself.
	 *
	 * @throws When the worker or agent can't be reached.
	 */
	async view(ws: WorkstationDTO): Promise<WorkstationView> {
		const target = await this.#target(ws);
		const status = await this.#call<WorkstationStatus>(
			target,
			"GET",
			`/v1/workstations/${ws.id}`,
			{ query: { port: String(ws.toJSON().port) } },
		);
		const host = this.hostname(ws);
		const { autoStopAt } = ws.toJSON();
		if (target.kind === "local") {
			return {
				autoStopAt,
				status,
				url: status.state === "running" ? `https://${host}` : null,
			};
		}
		if (status.state !== "running" || status.hostPort === 0) {
			await this.#removeRoute(ws);
			return { autoStopAt, status, url: null };
		}
		const upstream = `http://${target.address}:${status.hostPort}`;
		const routed = await this.#writeRoute(ws, host, upstream);
		return {
			autoStopAt,
			status,
			url: routed ? `https://${host}` : upstream,
		};
	}

	/**
	 * Opens `ws`'s container output, the last 500 lines then everything it
	 * writes after, as a text stream.
	 *
	 * @throws When the worker or agent can't be reached, or the workstation
	 *   has no container yet (a 404).
	 */
	async streamLogs(ws: WorkstationDTO): Promise<ReadableStream<Uint8Array>> {
		const target = await this.#target(ws);
		const path = `/v1/workstations/${ws.id}/logs`;
		const query = { follow: "1", tail: "500" };
		return target.kind === "agent"
			? await AgentClientService.stream(target.connection, path, query)
			: await WorkerClient.stream(path, { query });
	}

	/**
	 * Checks `ws` end to end: the container runs, an agent host's published
	 * port answers, the hostname resolves, and `https://<host>/` reaches the
	 * IDE through Traefik. Never throws: every failure comes back as a failed
	 * check with its reason.
	 */
	async selfTest(ws: WorkstationDTO): Promise<WorkstationCheck[]> {
		const checks: WorkstationCheck[] = [];
		let view: WorkstationView;
		try {
			view = await this.view(ws);
		} catch (error) {
			return [{ detail: messageOf(error), label: "Container", ok: false }];
		}
		checks.push(containerCheck(view.status));
		if (view.status.state !== "running") {
			return checks;
		}
		const target = await this.#target(ws).catch(() => null);
		if (target?.kind === "agent") {
			checks.push(
				await this.#probeUpstream(target.address, view.status.hostPort),
			);
			if (!config.traefik.dynamicConfigDir) {
				checks.push({
					detail:
						"Traefik has no dynamic config directory configured, so an agent-hosted workstation can't be routed at its hostname; it's only reachable at the published port.",
					label: "Traefik route",
					ok: false,
				});
				return checks;
			}
		}
		const host = this.hostname(ws);
		checks.push(await this.#probeDns(host));
		checks.push(await this.#probeRoute(host, ws.toJSON().port));
		return checks;
	}

	/** Whether the IDE answers on the port an agent host published it on. */
	async #probeUpstream(
		address: string,
		hostPort: number,
	): Promise<WorkstationCheck> {
		const label = `Published port ${address}:${hostPort}`;
		if (hostPort === 0) {
			return {
				detail: "The agent reports no published port for the IDE.",
				label,
				ok: false,
			};
		}
		try {
			const response = await fetch(`http://${address}:${hostPort}/`, {
				redirect: "manual",
				signal: AbortSignal.timeout(5000),
			});
			return {
				detail: `The IDE answered ${response.status} on the agent host.`,
				label,
				ok: response.status < 500,
			};
		} catch (error) {
			return {
				detail: `Unreachable from this server (${messageOf(error)}): a firewall on the agent host may be blocking the port.`,
				label,
				ok: false,
			};
		}
	}

	/** Whether `host` resolves at all. */
	async #probeDns(host: string): Promise<WorkstationCheck> {
		try {
			const addresses = await dns.lookup(host, { all: true });
			return {
				detail: `Resolves to ${addresses.map((entry) => entry.address).join(", ")}.`,
				label: "DNS",
				ok: true,
			};
		} catch (error) {
			return {
				detail: `${host} doesn't resolve (${messageOf(error)}). Point it, or a wildcard *.${config.baseDomain}, at this server.`,
				label: "DNS",
				ok: false,
			};
		}
	}

	/** Fetches `https://<host>/` the way a browser would, through Traefik. */
	async #probeRoute(host: string, port: number): Promise<WorkstationCheck> {
		try {
			const response = await fetch(`https://${host}/`, {
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
			});
			return routeCheck(host, response.status, port);
		} catch (error) {
			const message = messageOf(error);
			return {
				detail: CERT_ERROR_RE.test(message)
					? `The certificate doesn't verify (${message}). Traefik may still be requesting it, or serving its default one because no HTTPS router matches ${host}.`
					: `Unreachable: ${message}`,
				label: `https://${host}`,
				ok: false,
			};
		}
	}

	/**
	 * Points `ws`'s hostname at this server through every configured DNS
	 * provider (a Pangolin resource, a DNS record), with Pangolin's sign-in
	 * off since the IDE has its own password.
	 *
	 * @throws When a provider fails, with each failure's reason.
	 */
	async #syncDns(ws: WorkstationDTO): Promise<void> {
		const failed = (await syncDns([this.hostname(ws)], { sso: false })).filter(
			(result) => !result.ok,
		);
		if (failed.length > 0) {
			throw new Error(
				`The workstation runs, but its hostname isn't routed: ${failed
					.map((result) => `${result.provider}: ${result.detail}`)
					.join("; ")}`,
			);
		}
	}

	/** Writes an agent-hosted workstation's route when it changed; false when there's no dynamic config directory. */
	async #writeRoute(
		ws: WorkstationDTO,
		host: string,
		upstream: string,
	): Promise<boolean> {
		const dir = config.traefik.dynamicConfigDir;
		if (!dir) {
			return false;
		}
		const path = join(dir, workstationRouteFile(ws.slug));
		const contents = workstationRouteYaml(ws.slug, host, upstream);
		const current = await readFile(path, "utf8").catch(() => null);
		if (current !== contents) {
			await mkdir(dir, { recursive: true });
			await writeFile(path, contents);
			logger.info(
				`Wrote workstation route: workstation=${ws.id} upstream=${upstream}`,
			);
		}
		return true;
	}

	/** Drops an agent-hosted workstation's route file, if any. */
	async #removeRoute(ws: WorkstationDTO): Promise<void> {
		const dir = config.traefik.dynamicConfigDir;
		if (!dir) {
			return;
		}
		await rm(join(dir, workstationRouteFile(ws.slug)), { force: true });
	}
}

export const WorkstationService = new WorkstationServiceClass();
