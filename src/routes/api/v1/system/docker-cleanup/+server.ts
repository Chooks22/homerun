import { ServiceVolumeDTO } from "#lib/dto/service-volume-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { apiCaller, readApiBody } from "#lib/server/api-route.js";
import { dockerCleanupApiBody } from "#lib/server/validation/operations-api.js";
import { DockerService } from "#lib/services/docker.service.js";
import { enqueueCleanup } from "#lib/services/docker-cleanup-queue.js";
import { RevisionService } from "#lib/services/revision.service.js";

export const GET = async ({ locals }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const [keepImageIds, keepVolumeNames, stackIds] = await Promise.all([
		RevisionService.retainedImageIds(),
		ServiceVolumeDTO.mountedVolumeNames(),
		StackDTO.allIds(),
	]);
	const [preview, orphanStackNetworks] = await Promise.all([
		DockerService.getCleanupPreview(keepImageIds, keepVolumeNames),
		DockerService.findOrphanStackNetworks(stackIds),
	]);
	return Response.json({ ...preview, orphanStackNetworks });
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, dockerCleanupApiBody);
	if ("response" in body) {
		return body.response;
	}
	const job = await enqueueCleanup(
		body.data.action,
		body.data.all,
		caller.userId,
	);
	return Response.json(
		{ action: body.data.action, jobId: job.id },
		{ status: 202 },
	);
};
