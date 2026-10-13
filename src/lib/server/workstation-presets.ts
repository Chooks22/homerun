import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import type { WorkstationPresetInput } from "#lib/dto/workstation-preset-dto.js";
import type { Workstation } from "#lib/server/db/schema.js";

/**
 * Why `remoteHostId` can't run a workstation, null when it can (this server
 * or an agent host).
 */
export async function agentHostProblem(
	remoteHostId: string | null,
): Promise<string | null> {
	if (!remoteHostId) {
		return null;
	}
	const host = await RemoteHostDTO.get(remoteHostId);
	return host?.kind === "agent"
		? null
		: "Workstations run on this server or on an agent host.";
}

/** A workstation's settings as a preset named `name`, everything but its identity and runtime state. */
export function presetFromWorkstation(
	ws: Omit<Workstation, "passwordEnc">,
	name: string,
	description: string | null,
): WorkstationPresetInput {
	return {
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
