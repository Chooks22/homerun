import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { backupDestinationApiJson } from "#lib/server/api-json.js";
import { jsonPage, parseApiListQuery } from "#lib/server/api-pagination.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { parseDestinationForm } from "#lib/server/backup-destination-form.js";
import { backupDestinationApiBody } from "#lib/server/validation/api-resources.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const paged = await S3DestinationDTO.listPaged(parseApiListQuery(url));
	return jsonPage(
		paged.items.map((destination) =>
			backupDestinationApiJson(destination.toJSON()),
		),
		paged,
	);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, backupDestinationApiBody);
	if ("response" in body) {
		return body.response;
	}
	const result = parseDestinationForm(new Map(Object.entries(body.data)));
	if ("error" in result) {
		return apiError(result.error);
	}
	const destination = await S3DestinationDTO.create({
		...result.parsed,
		backupKeep: body.data.backupKeep,
		userId: caller.userId,
	});
	return Response.json(backupDestinationApiJson(destination.toJSON()), {
		status: 201,
	});
};
