import { fail } from "@sveltejs/kit";
import { S3DestinationDTO } from "#lib/dto/s3-destination-dto.js";
import { Logger } from "#lib/logger.js";
import { parseDestinationForm } from "#lib/server/backup-destination-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const logger = new Logger("S3Destinations");

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const result = parseDestinationForm(await request.formData());
		if ("error" in result) {
			return fail(400, { error: result.error });
		}

		const destination = await S3DestinationDTO.create({
			...result.parsed,
			userId: locals.user.id,
		});

		logger.info(
			`Backup destination added: destination=${destination.id} type=${destination.type} user=${locals.user.id}`,
		);

		return { destinationId: destination.id, success: true };
	},
};
