import { fail, redirect } from "@sveltejs/kit";
import { isBlockSeverity } from "#lib/image-scan.js";
import { Logger } from "#lib/logger.js";
import { nullableText } from "#lib/server/validation/instance-settings-form.js";
import { DockerService } from "#lib/services/docker.service.js";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "#lib/services/instance-settings.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("InstanceSettings");

export const load = async () => ({
	swarmUnavailableReason: await DockerService.swarmModeUnavailableReason(),
});

export const actions = {
	updateDocker: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		await InstanceSettingsService.saveDocker(
			{
				dockerNetworkName: nullableText(formData, "dockerNetworkName"),
				dockerSocketPath: nullableText(formData, "dockerSocketPath"),
			},
			locals.user.id,
		);
		return { savedSection: "docker", success: true };
	},

	updateImageScan: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const severity = formData.get("imageScanBlockSeverity");
		if (severity !== "off" && !isBlockSeverity(severity)) {
			return fail(400, { error: "Invalid block policy." });
		}
		await InstanceSettingsService.saveImageScan(
			{
				imageScanBlockFixableOnly:
					formData.get("imageScanBlockFixableOnly") === "on",
				imageScanBlockSeverity: isBlockSeverity(severity) ? severity : null,
				imageScanEnabled: formData.get("imageScanEnabled") === "on",
				imageScanRequired: formData.get("imageScanRequired") === "on",
			},
			locals.user.id,
		);
		return { savedSection: "imageScan", success: true };
	},

	updateRetainedImages: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		try {
			await InstanceSettingsService.saveRetainedImages(
				Number(formData.get("retainedImagesPerService")),
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof InstanceSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { savedSection: "retainedImages", success: true };
	},

	updateOrchestration: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const mode = formData.get("orchestrationMode") as string | null;
		if (mode !== "standalone" && mode !== "swarm") {
			return fail(400, { error: "Invalid orchestration mode." });
		}
		try {
			const steps = await InstanceSettingsService.setOrchestrationMode(
				mode,
				locals.user.id,
			);
			return {
				orchestrationSteps: steps,
				savedSection: "orchestration",
				success: true,
			};
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			logger.error(`Applying orchestration mode failed: ${detail}`);
			return fail(500, {
				error: `The host couldn't be prepared, so the mode wasn't changed: ${detail}`,
			});
		}
	},
};
