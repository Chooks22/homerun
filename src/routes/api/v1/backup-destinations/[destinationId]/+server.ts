import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { backupDestinationApiJson } from "#lib/server/api-json.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { parseDestinationForm } from "#lib/server/backup-destination-form.js";
import { updateBackupDestinationApiBody } from "#lib/server/validation/api-resources.js";

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const destination = await S3DestinationDTO.get(params.destinationId);
	return destination
		? Response.json(backupDestinationApiJson(destination.toJSON()))
		: apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const destination = await S3DestinationDTO.get(params.destinationId);
	if (!destination) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateBackupDestinationApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { secretAccessKeyEnc: _secret, ...current } = destination.toJSON();
	const result = parseDestinationForm(
		new Map(Object.entries({ ...current, ...body.data })),
		{ keepSecret: true },
	);
	if ("error" in result) {
		return apiError(result.error);
	}
	await destination.update({
		...result.parsed,
		...(body.data.backupKeep === undefined
			? {}
			: { backupKeep: body.data.backupKeep }),
	});
	return Response.json(backupDestinationApiJson(destination.toJSON()));
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const destination = await S3DestinationDTO.get(params.destinationId);
	if (!destination) {
		return apiError("Not found", 404);
	}
	await destination.delete();
	return new Response(null, { status: 204 });
};
