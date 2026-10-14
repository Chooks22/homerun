import { stripAnsi } from "#lib/ansi.js";
import { apiCaller, apiError } from "#lib/server/api-route.js";
import { DockerService } from "#lib/services/docker.service.js";

export const GET = async ({ locals, params, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const tail = Number(url.searchParams.get("tail") ?? 200);
	if (!Number.isInteger(tail) || tail < 1 || tail > 10_000) {
		return apiError("tail must be a whole number from 1 to 10000.");
	}
	const infra = await DockerService.listInfraContainers();
	if (!infra.some((container) => container.id === params.containerId)) {
		return apiError("Not found", 404);
	}
	const stream = await DockerService.streamLogs(params.containerId, {
		follow: false,
		tail,
	});
	return new Response(stripAnsi(await new Response(stream).text()), {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
};
