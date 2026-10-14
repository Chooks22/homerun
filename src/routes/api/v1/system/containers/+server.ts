import { apiCaller } from "#lib/server/api-route.js";
import { DockerService } from "#lib/services/docker.service.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	return Response.json(await DockerService.listInfraContainers());
};
