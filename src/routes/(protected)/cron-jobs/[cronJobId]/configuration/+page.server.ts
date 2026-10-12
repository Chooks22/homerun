import { fail, redirect } from "@sveltejs/kit";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import {
	manageableCronJob,
	parseCronJobSection,
} from "#lib/server/cron-job-form.js";
import { resolve } from "$app/paths";

const logger = new Logger("CronJob");

export const load = async ({ parent }) => {
	await parent();
	const [hosts, volumes] = await Promise.all([
		RemoteHostDTO.list(),
		StorageVolumeDTO.list(),
	]);
	return {
		remoteHosts: hosts
			.filter((host) => host.kind === "docker")
			.map((host) => ({ id: host.id, name: host.name })),
		volumes: volumes.map((volume) => ({ id: volume.id, name: volume.name })),
	};
};

export const actions = {
	update: async ({ params, request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const found = await manageableCronJob(params.cronJobId, locals.permissions);
		if ("error" in found) {
			return fail(found.status, { error: found.error });
		}
		const result = parseCronJobSection(
			found.job.toJSON(),
			await request.formData(),
			"configuration",
			{ hostAccess: can(locals.permissions, "system", "write") },
		);
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		const { registryPasswordEnc, ...rest } = result.parsed;
		await found.job.update({
			...rest,
			...(registryPasswordEnc ? { registryPasswordEnc } : {}),
		});
		logger.info(
			`Cron job configuration updated: job=${found.job.id} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
