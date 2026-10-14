import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import type { WorkstationPresetInput } from "#lib/dto/workstation-preset-dto.js";
import type { Workstation } from "#lib/server/db/schema.js";

/** Whether `host` can run a workstation: an agent, or a raw Docker daemon the worker reaches over `tcp://` or `ssh://`. */
export function canRunWorkstation(host: RemoteHostDTO): boolean {
	return host.kind === "agent" || !!host.dockerHost;
}

/**
 * Why `remoteHostId` can't run a workstation, null when it can (this server,
 * an agent host or a Docker host).
 */
export async function workstationHostProblem(
	remoteHostId: string | null,
): Promise<string | null> {
	if (!remoteHostId) {
		return null;
	}
	const host = await RemoteHostDTO.get(remoteHostId);
	return host && canRunWorkstation(host)
		? null
		: "Workstations run on this server, an agent host or a Docker host.";
}

/** Every remote host that can run a workstation, for the "Runs on" picker. */
export async function workstationHosts(): Promise<
	{ id: string; name: string }[]
> {
	const hosts = await RemoteHostDTO.list();
	return hosts
		.filter(canRunWorkstation)
		.map((host) => ({ id: host.id, name: host.name }));
}

/** A workstation's settings and login wall as a preset named `name`, everything but its identity and runtime state. */
export function presetFromWorkstation(
	ws: Omit<Workstation, "passwordEnc">,
	name: string,
	description: string | null,
): WorkstationPresetInput {
	return {
		authAllowedEmails: ws.authAllowedEmails,
		authAllowedGroups: ws.authAllowedGroups,
		authAllowedUserIds: ws.authAllowedUserIds,
		authProviders: ws.authProviders,
		authRequired: ws.authRequired,
		cpuLimit: ws.cpuLimit,
		description,
		editorSettings: ws.editorSettings,
		env: ws.env,
		extensions: ws.extensions,
		gitAuthorEmail: ws.gitAuthorEmail,
		gitAuthorName: ws.gitAuthorName,
		gitBranch: ws.gitBranch,
		gitProviderId: ws.gitProviderId,
		gitUrl: ws.gitUrl,
		homePath: ws.homePath,
		image: ws.image,
		memoryLimitMb: ws.memoryLimitMb,
		name,
		port: ws.port,
		remoteHostId: ws.remoteHostId,
	};
}
