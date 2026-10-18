import { fail, redirect } from "@sveltejs/kit";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { parseCronJobForm } from "#lib/server/cron-job-form.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { resolve } from "$app/paths";

const logger = new Logger("CronJob");

export const load = async ({ locals, parent }) => {
	await parent();
	const [hosts, volumes] = await Promise.all([
		RemoteHostDTO.list(),
		StorageVolumeDTO.list(),
	]);
	return {
		hostAccess: can(locals.permissions, "system", "write"),
		remoteHosts: hosts
			.filter((host) => host.kind === "docker")
			.map((host) => ({ id: host.id, name: host.name })),
		volumes: volumes.map((volume) => ({ id: volume.id, name: volume.name })),
	};
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const result = parseCronJobForm(formData, {
			hostAccess: can(locals.permissions, "system", "write"),
		});
		if ("error" in result) {
			return fail(400, { error: result.error });
		}

		const job = await CronJobDTO.create({
			...result.parsed,
			userId: locals.user.id,
		});

		logger.info(
			`Cron job created: job=${job.id} kind=${job.kind} user=${locals.user.id}`,
		);
		redirect(303, `${resolve("cron-jobs")}/${job.id}`);
	},
};
