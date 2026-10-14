import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { Logger } from "#lib/logger.js";
import type { RemoteHost } from "#lib/server/db/schema.js";
import { AgentClientService } from "#lib/services/agent-client.service.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { WorkstationService } from "#lib/services/workstation.service.js";

const logger = new Logger("RemoteHosts");

/** A remote host change refused for the caller's input; nothing was saved. */
export class RemoteHostSettingsError extends Error {}

/** A remote host's settings as the dashboard's form and the REST API send them; a blank secret keeps the stored one. */
export interface RemoteHostSettings {
	agentToken?: string | null;
	agentUrl?: string | null;
	dockerHost?: string | null;
	kind?: RemoteHost["kind"];
	name?: string | null;
	tlsCa?: string | null;
	tlsCert?: string | null;
	tlsKey?: string | null;
}

/** A trimmed value, empty when missing. */
function trimmed(value: string | null | undefined): string {
	return value?.trim() ?? "";
}

/** The agent URL, checked to be a full URL. */
function checkedAgentUrl(value: string): string {
	if (!value) {
		throw new RemoteHostSettingsError("Agent URL is required.");
	}
	if (!URL.canParse(value)) {
		throw new RemoteHostSettingsError(
			"Agent URL must be a full URL, e.g. http://192.168.1.50:7420.",
		);
	}
	return value;
}

/** The Docker daemon address, checked to be a tcp:// URL or an ssh:// one naming its user. */
function checkedDockerHost(value: string): string {
	if (!URL.canParse(value)) {
		throw new RemoteHostSettingsError(
			"Docker host must be a URL, e.g. tcp://host:2376 or ssh://user@host.",
		);
	}
	const { protocol, username } = new URL(value);
	if (!(protocol === "tcp:" || protocol === "ssh:")) {
		throw new RemoteHostSettingsError(
			"Only tcp:// and ssh:// hosts are supported.",
		);
	}
	if (protocol === "ssh:" && !username) {
		throw new RemoteHostSettingsError(
			"An ssh:// Docker host needs a user, e.g. ssh://user@host.",
		);
	}
	return value;
}

/** The TLS material sent, encrypted, leaving out the blank fields so the stored ones stay. */
function tlsColumns(input: RemoteHostSettings) {
	const ca = trimmed(input.tlsCa);
	const cert = trimmed(input.tlsCert);
	const key = trimmed(input.tlsKey);
	return {
		...(ca ? { tlsCaEnc: encryptSecret(ca) } : {}),
		...(cert ? { tlsCertEnc: encryptSecret(cert) } : {}),
		...(key ? { tlsKeyEnc: encryptSecret(key) } : {}),
	};
}

/** Asks the agent at `agentUrl` to accept `token`. */
async function verifyAgent(agentUrl: string, token: string): Promise<void> {
	try {
		await AgentClientService.verifyToken(agentUrl, token);
	} catch (error) {
		throw new RemoteHostSettingsError(
			error instanceof Error ? error.message : "Couldn't verify the agent.",
		);
	}
}

/**
 * Registering and editing remote hosts (build servers: a raw Docker daemon
 * or a Homerun Agent), shared by the Remote hosts pages and the REST API. An
 * agent's token is checked against the agent itself before anything is
 * saved.
 */
class RemoteHostSettingsServiceClass {
	/**
	 * Registers a remote host owned by `userId`.
	 *
	 * @throws {RemoteHostSettingsError} When a field is missing or invalid, or
	 *   the agent refuses the token.
	 */
	async create(
		input: RemoteHostSettings,
		userId: string,
	): Promise<RemoteHostDTO> {
		const name = trimmed(input.name);
		if (!name) {
			throw new RemoteHostSettingsError("Name is required.");
		}
		if (input.kind === "agent") {
			const agentUrl = trimmed(input.agentUrl);
			const agentToken = trimmed(input.agentToken);
			if (!(agentUrl && agentToken)) {
				throw new RemoteHostSettingsError("Agent URL and token are required.");
			}
			await verifyAgent(checkedAgentUrl(agentUrl), agentToken);
			const host = await RemoteHostDTO.create({
				agentTokenEnc: encryptSecret(agentToken),
				agentUrl,
				kind: "agent",
				name,
				userId,
			});
			logger.info(
				`Remote host added: host=${host.id} kind=agent agentUrl=${agentUrl} user=${userId}`,
			);
			return host;
		}
		const dockerHost = checkedDockerHost(trimmed(input.dockerHost));
		const host = await RemoteHostDTO.create({
			dockerHost,
			kind: "docker",
			name,
			...tlsColumns(input),
			userId,
		});
		logger.info(
			`Remote host added: host=${host.id} kind=docker dockerHost=${dockerHost} user=${userId}`,
		);
		return host;
	}

	/**
	 * Saves the fields sent, keeping the rest. An agent is verified again
	 * whenever its URL or token changes; a blank token or TLS field keeps the
	 * stored one. Pointing a Docker host at a different ssh:// address forgets
	 * the recorded SSH host key, so the new one is recorded on first use.
	 *
	 * @throws {RemoteHostSettingsError} When a field is invalid, or the agent
	 *   refuses the token.
	 */
	async update(host: RemoteHostDTO, input: RemoteHostSettings): Promise<void> {
		const name = input.name === undefined ? host.name : trimmed(input.name);
		if (!name) {
			throw new RemoteHostSettingsError("Name is required.");
		}
		if (host.kind === "agent") {
			const agentUrl = checkedAgentUrl(
				input.agentUrl === undefined
					? (host.agentUrl ?? "")
					: trimmed(input.agentUrl),
			);
			const agentToken = trimmed(input.agentToken);
			const existing = host.toAgentConnection();
			if (agentToken || existing?.agentUrl !== agentUrl) {
				const token = agentToken || existing?.token;
				if (!token) {
					throw new RemoteHostSettingsError("Agent token is required.");
				}
				await verifyAgent(agentUrl, token);
			}
			await host.update({
				agentUrl,
				name,
				...(agentToken ? { agentTokenEnc: encryptSecret(agentToken) } : {}),
			});
			logger.info(`Remote host updated: host=${host.id} kind=agent`);
			return;
		}
		const dockerHost = checkedDockerHost(
			input.dockerHost === undefined
				? (host.dockerHost ?? "")
				: trimmed(input.dockerHost),
		);
		const sshMoved =
			dockerHost !== host.dockerHost && dockerHost.startsWith("ssh://");
		await host.update({
			dockerHost,
			name,
			...tlsColumns(input),
			...(sshMoved ? { sshHostKey: null } : {}),
		});
		logger.info(`Remote host updated: host=${host.id} kind=docker`);
	}

	/**
	 * Deletes `host`, first cleaning up the workstations on it (their
	 * containers, routes and DNS, best effort) since their rows cascade with
	 * it.
	 */
	async remove(host: RemoteHostDTO): Promise<void> {
		await WorkstationService.removeAllOnHost(host.id);
		await host.delete();
	}
}

export const RemoteHostSettingsService = new RemoteHostSettingsServiceClass();
