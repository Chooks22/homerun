import { fail } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { ImageScanDTO } from "#lib/dto/image-scan-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import {
	AUTH_PATHS_MODES,
	parsePathPatterns,
	pathPatternsProblem,
} from "#lib/path-patterns.js";
import { can } from "#lib/permissions.js";
import { parseLoginWallForm } from "#lib/server/login-wall-form.js";
import {
	loginWallAvailability,
	loginWallOptions,
} from "#lib/server/login-wall-options.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { errorPagesPublished } from "#lib/services/docker/error-pages.js";
import { ImageScanService } from "#lib/services/image-scan.service.js";
import {
	ServiceSettingsError,
	ServiceSettingsService,
} from "#lib/services/service-settings.service.js";

const logger = new Logger("ImageScan");
const accessLogger = new Logger("Services");

export const load = async ({ locals, params, parent }) => {
	await parent();
	const [scans, scanning, settings, wall] = await Promise.all([
		ImageScanDTO.listForService(params.serviceId, 15),
		ImageScanService.isScanning(params.serviceId),
		InstanceSettingsDTO.get(),
		loginWallOptions(),
	]);
	return {
		...wall,
		blockPolicy: settings.imageScanBlockPolicy,
		blockedPageAvailable: errorPagesPublished(),
		canChangeScanPolicy: can(locals.permissions, "settings", "write"),
		instanceScanEnabled: settings.imageScanEnabled,
		scanning,
		scans: scans.map((scan) => scan.toJSON()),
	};
};

export const actions = {
	scan: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		if (!(svc.containerId || svc.swarmServiceId)) {
			return fail(400, {
				error: "Deploy the service first : there's no deployed image to scan.",
			});
		}
		const job = await ImageScanService.enqueueScan(svc, locals.user.id);
		logger.info(
			`Image scan queued: service=${svc.id} job=${job.id} user=${locals.user.id}`,
		);
		return { queued: true };
	},
	updateAppAuth: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const parsed = parseLoginWallForm(
			await request.formData(),
			await loginWallAvailability(),
			config.auth.origin,
		);
		if ("error" in parsed) {
			return fail(400, { authError: parsed.error });
		}
		const { policy } = parsed;
		const saved = await ServiceSettingsService.save(svc, policy, {
			hostAccess: can(locals.permissions, "system", "write"),
			userId: locals.user.id,
		});
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { authError: saved.message });
		}
		const { redeploying } = saved;

		accessLogger.info(
			`App access updated: service=${svc.id} authRequired=${policy.authRequired} methods=${policy.authProviders.join("|") || "none"} user=${locals.user.id}`,
		);

		return { authSuccess: true, redeploying };
	},
	updateBlockedPaths: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const blockedPaths = parsePathPatterns(
			String((await request.formData()).get("blockedPaths") ?? ""),
		);
		const problem = pathPatternsProblem(blockedPaths);
		if (problem) {
			return fail(400, { error: problem });
		}
		const saved = await ServiceSettingsService.save(
			svc,
			{ blockedPaths },
			{
				hostAccess: can(locals.permissions, "system", "write"),
				userId: locals.user.id,
			},
		);
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { error: saved.message });
		}
		const { redeploying } = saved;
		accessLogger.info(
			`Blocked paths updated: service=${svc.id} count=${blockedPaths.length} user=${locals.user.id}`,
		);
		return { redeploying };
	},
	updateAuthPaths: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const formData = await request.formData();
		const authPathsMode = AUTH_PATHS_MODES.find(
			(mode) => mode === formData.get("authPathsMode"),
		);
		if (!authPathsMode) {
			return fail(400, { error: "Pick which paths the login wall covers." });
		}
		const authPaths = parsePathPatterns(
			String(formData.get("authPaths") ?? ""),
		);
		const problem = pathPatternsProblem(authPaths);
		if (problem) {
			return fail(400, { error: problem });
		}
		const saved = await ServiceSettingsService.save(
			svc,
			{ authPaths, authPathsMode },
			{
				hostAccess: can(locals.permissions, "system", "write"),
				userId: locals.user.id,
			},
		);
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { error: saved.message });
		}
		const { redeploying } = saved;
		accessLogger.info(
			`Login wall paths updated: service=${svc.id} mode=${authPathsMode} count=${authPaths.length} user=${locals.user.id}`,
		);
		return { redeploying };
	},
};
