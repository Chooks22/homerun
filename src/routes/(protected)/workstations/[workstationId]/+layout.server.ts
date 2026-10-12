import { error } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { workstationHostname } from "#lib/workstations.js";

export const load = async ({ params, parent }) => {
	const { user } = await parent();
	const ws = await WorkstationDTO.get(params.workstationId, user.id);
	if (!ws) {
		error(404, "Workstation not found");
	}
	const host = ws.remoteHostId
		? await RemoteHostDTO.get(ws.remoteHostId)
		: null;
	return {
		hostName: host?.name ?? null,
		hostname: workstationHostname(ws.slug, config.baseDomain),
		workstation: ws.toPublic(),
	};
};
