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
import {
	agentHostAddress,
	workstationLabels,
	workstationRouteFile,
	workstationRouteYaml,
} from "#lib/services/workstation/routing.js";
import {
	repoDirectory,
	type WorkstationStatus,
	workstationHostname,
} from "#lib/workstations.js";

const logger = new Logger("Workstation");

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
			await ws.update({ desiredState: "running", lastError: null });
			logger.info(`Workstation starting: workstation=${ws.id}`);
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
		await ws.update({ desiredState: "stopped" });
		await this.#removeRoute(ws);
		logger.info(`Workstation stopped: workstation=${ws.id}`);
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
		if (target.kind === "local") {
			return {
				status,
				url: status.state === "running" ? `https://${host}` : null,
			};
		}
		if (status.state !== "running" || status.hostPort === 0) {
			await this.#removeRoute(ws);
			return { status, url: null };
		}
		const upstream = `http://${target.address}:${status.hostPort}`;
		const routed = await this.#writeRoute(ws, host, upstream);
		return { status, url: routed ? `https://${host}` : upstream };
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
