import { fail } from "@sveltejs/kit";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const logger = new Logger("S3Destinations");

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(
		url,
		{ sortKeys: sortKeysOf(BASE_SORTS) },
		preferences.perPage,
	);
	const paged = await S3DestinationDTO.listPaged(query);
	return {
		destinations: paged.items.map((destination) => {
			const {
				resticPasswordEnc: _restic,
				secretAccessKeyEnc: _secret,
				...row
			} = destination.toJSON();
			return { ...row, capacity: destination.capacity };
		}),
		filtered: query.active,
		page: paged.page,
		perPage: paged.perPage,
		total: paged.total,
	};
};

export const actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const destinationId = formData.get("destinationId") as string | null;
		if (!destinationId) {
			return fail(400, { error: "Missing destination id." });
		}

		const destination = await S3DestinationDTO.get(destinationId);
		if (!destination) {
			return fail(404, { error: "Destination not found." });
		}

		await destination.delete();
		logger.info(
			`Backup destination deleted: destination=${destinationId} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
