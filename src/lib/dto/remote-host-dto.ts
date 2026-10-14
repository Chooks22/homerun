import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "#lib/server/db/lib.js";
import { type RemoteHost, remoteHost } from "#lib/server/db/schema.js";
import {
	type ListQuery,
	narrowFilter,
	type PagedResult,
	searchCondition,
	sortOrder,
} from "#lib/server/list-query.js";
import { WorkerClient } from "#lib/server/worker-client.js";
import type { AgentConnection } from "#lib/services/agent-client.service.js";
import type { RemoteHostConnection } from "#lib/services/docker.service.js";
import { decryptSecret } from "#lib/services/secrets.js";
import { BaseDTO } from "./base-dto";
import { InstanceSettingsDTO } from "./instance-settings-dto";

export interface NewRemoteHostInput {
	agentTokenEnc?: string | null;
	agentUrl?: string | null;
	dockerHost?: string | null;
	kind?: RemoteHost["kind"];
	name: string;
	tlsCaEnc?: string | null;
	tlsCertEnc?: string | null;
	tlsKeyEnc?: string | null;
	userId: string;
}

export type RemoteHostUpdateInput = Partial<
	Pick<
		RemoteHost,
		| "agentTokenEnc"
		| "agentUrl"
		| "dockerHost"
		| "kind"
		| "name"
		| "sshHost"
		| "sshHostKey"
		| "sshPort"
		| "sshUser"
		| "tlsCaEnc"
		| "tlsCertEnc"
		| "tlsKeyEnc"
	>
>;

/** Where a git build actually runs : this host, a remote Docker daemon, or a Homerun Agent. */
export type RemoteExecutionTarget =
	| { kind: "local" }
	| { connection: RemoteHostConnection; hostId: string; kind: "docker" }
	| { connection: AgentConnection; hostId: string; kind: "agent" };

/** Wraps the `remote_host` table : see ServiceDTO for the pattern this follows. */
export class RemoteHostDTO extends BaseDTO<RemoteHost> {
	/** Loads one remote host by id; null when missing. */
	static async get(id: string): Promise<RemoteHostDTO | null> {
		const [row] = await db
			.select()
			.from(remoteHost)
			.where(eq(remoteHost.id, id))
			.limit(1);
		return row ? new RemoteHostDTO(row) : null;
	}

	/** Every remote host on the instance, newest first. */
	static async list(): Promise<RemoteHostDTO[]> {
		const rows = await db
			.select()
			.from(remoteHost)
			.orderBy(desc(remoteHost.createdAt));
		return rows.map((row) => new RemoteHostDTO(row));
	}

	/** One page of `list`, searched/filtered server-side, plus the unpaged total. */
	static async listPaged(
		query: ListQuery,
	): Promise<PagedResult<RemoteHostDTO>> {
		const conditions: SQL[] = [];
		const search = searchCondition(query.q, [
			remoteHost.name,
			remoteHost.dockerHost,
			remoteHost.agentUrl,
		]);
		if (search) {
			conditions.push(search);
		}
		const kinds = narrowFilter(query.filters.kind, [
			"docker",
			"agent",
		] as const);
		if (kinds.length > 0) {
			conditions.push(inArray(remoteHost.kind, kinds));
		}
		const where = and(...conditions);

		const [rows, totals] = await Promise.all([
			db
				.select()
				.from(remoteHost)
				.where(where)
				.orderBy(
					...sortOrder(
						query.sort,
						{
							created: remoteHost.createdAt,
							name: remoteHost.name,
							updated: remoteHost.updatedAt,
						},
						desc(remoteHost.createdAt),
					),
				)
				.limit(query.limit)
				.offset(query.offset),
			db.select({ total: count() }).from(remoteHost).where(where),
		]);

		return {
			items: rows.map((row) => new RemoteHostDTO(row)),
			page: query.page,
			perPage: query.perPage,
			total: totals[0]?.total ?? 0,
		};
	}

	/** Every registered host, all of which are build servers : `kind: "docker"` (the worker builds straight against that daemon) and `kind: "agent"` (its own `POST /v1/build`) alike. */
	static listBuildServers(): Promise<RemoteHostDTO[]> {
		return RemoteHostDTO.list();
	}

	/**
	 * Up to `limit` hosts whose name, Docker host or agent URL
	 * matches `q`, newest first, for global search.
	 */
	static async search(q: string, limit: number): Promise<RemoteHostDTO[]> {
		const rows = await db
			.select()
			.from(remoteHost)
			.where(
				searchCondition(q, [
					remoteHost.name,
					remoteHost.dockerHost,
					remoteHost.agentUrl,
				]),
			)
			.orderBy(desc(remoteHost.createdAt))
			.limit(limit);
		return rows.map((row) => new RemoteHostDTO(row));
	}

	/**
	 * Inserts a new remote host, defaulting to a raw Docker daemon connection.
	 * Secrets must already be encrypted.
	 */
	static async create(input: NewRemoteHostInput): Promise<RemoteHostDTO> {
		const now = new Date();
		const kind = input.kind ?? "docker";
		const row: RemoteHost = {
			agentTokenEnc: input.agentTokenEnc ?? null,
			agentUrl: input.agentUrl ?? null,
			createdAt: now,
			dockerHost: input.dockerHost ?? null,
			id: crypto.randomUUID(),
			kind,
			name: input.name,
			sshHost: null,
			sshHostKey: null,
			sshPort: null,
			sshUser: null,
			tlsCaEnc: input.tlsCaEnc ?? null,
			tlsCertEnc: input.tlsCertEnc ?? null,
			tlsKeyEnc: input.tlsKeyEnc ?? null,
			updatedAt: now,
			userId: input.userId,
		};
		await db.insert(remoteHost).values(row);
		return new RemoteHostDTO(row);
	}

	/** Writes the given fields to the row and mirrors them onto this instance. */
	async update(input: RemoteHostUpdateInput): Promise<void> {
		await db
			.update(remoteHost)
			.set(input)
			.where(eq(remoteHost.id, this.row.id));
		Object.assign(this.row, input);
	}

	/** Row-only delete : services referencing this host as a build server have it cleared by the FK's onDelete: set null. */
	async delete(): Promise<void> {
		await db.delete(remoteHost).where(eq(remoteHost.id, this.row.id));
	}

	/** Decrypts the stored TLS material into the `RemoteHostConnection` shape the worker's own remote-daemon client expects. Only meaningful for `kind: "docker"`. */
	toConnection(): RemoteHostConnection {
		return {
			dockerHost: this.row.dockerHost ?? "",
			id: this.row.id,
			tlsCa: this.row.tlsCaEnc ? decryptSecret(this.row.tlsCaEnc) : null,
			tlsCert: this.row.tlsCertEnc ? decryptSecret(this.row.tlsCertEnc) : null,
			tlsKey: this.row.tlsKeyEnc ? decryptSecret(this.row.tlsKeyEnc) : null,
		};
	}

	/**
	 * `toConnection`, plus what an `ssh://` daemon needs: the instance's SSH
	 * key and the host key recorded for this host. With none recorded yet, the
	 * worker connects once, trusting the key presented, checks the daemon
	 * answers, and that key is recorded (shared with this host's machine
	 * terminal) so a changed one is refused from then on.
	 *
	 * @throws When Homerun has no SSH key yet, or the worker can't reach the
	 *   daemon over SSH (key refused, forwarding refused, host unreachable).
	 */
	async toDockerConnection(): Promise<RemoteHostConnection> {
		const connection = this.toConnection();
		if (!connection.dockerHost.startsWith("ssh://")) {
			return connection;
		}
		const keyPair = (await InstanceSettingsDTO.get()).sshKeyPair;
		if (!keyPair) {
			throw new Error(
				"Homerun has no SSH key yet: open Terminal, add Homerun's public key to the remote user's ~/.ssh/authorized_keys, then try again.",
			);
		}
		let hostKey = this.row.sshHostKey;
		if (!hostKey) {
			const probed = await WorkerClient.post<{ hostKey: string }>(
				"/v1/ssh/docker-probe",
				{
					dockerHost: connection.dockerHost,
					sshHostKey: "",
					sshPrivateKey: keyPair.privateKey,
				},
			);
			hostKey = probed.hostKey;
			await this.update({ sshHostKey: hostKey });
		}
		return {
			...connection,
			sshHostKey: hostKey,
			sshPrivateKey: keyPair.privateKey,
		};
	}

	/** Decrypts the stored agent token into what agent-client.service.ts expects. Only meaningful for `kind: "agent"`. */
	toAgentConnection(): AgentConnection | null {
		const { agentTokenEnc, agentUrl, kind } = this.row;
		if (kind !== "agent" || !agentUrl || !agentTokenEnc) {
			return null;
		}
		const token = decryptSecret(agentTokenEnc);
		if (!token) {
			return null;
		}
		return { agentUrl, token };
	}

	/** The host's id. */
	get id(): string {
		return this.row.id;
	}
	/** The host's display name. */
	get name(): string {
		return this.row.name;
	}
	/** The Docker daemon address for a docker-kind host, null for agents. */
	get dockerHost(): string | null {
		return this.row.dockerHost;
	}
	/** Whether the host is a raw Docker daemon or a Homerun Agent. */
	get kind(): RemoteHost["kind"] {
		return this.row.kind;
	}
	/** The agent's base URL for an agent-kind host, null for Docker daemons. */
	get agentUrl(): string | null {
		return this.row.agentUrl;
	}

	/**
	 * Resolves a build server id into the connection its build should run
	 * through; a missing id means this host.
	 *
	 * @throws When the host doesn't exist, or is an agent without a
	 * usable URL and token.
	 */
	static async resolveBuildTarget(
		hostId: string | null | undefined,
	): Promise<RemoteExecutionTarget> {
		if (!hostId) {
			return { kind: "local" };
		}
		const host = await RemoteHostDTO.get(hostId);
		if (!host) {
			throw new Error(`Build server ${hostId} not found.`);
		}
		if (host.kind === "agent") {
			const connection = host.toAgentConnection();
			if (!connection) {
				throw new Error(
					`Build server ${hostId} has no usable agent connection.`,
				);
			}
			return { connection, hostId, kind: "agent" };
		}
		return {
			connection: await host.toDockerConnection(),
			hostId,
			kind: "docker",
		};
	}
}
