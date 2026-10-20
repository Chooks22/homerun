import { fail } from "@sveltejs/kit";
import { ErrorIssueDTO } from "#lib/dto/error-issue-dto.js";
import { ErrorProjectDTO } from "#lib/dto/error-project-dto.js";
import { ErrorSourceMapDTO } from "#lib/dto/error-source-map-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { changeIssueStatus } from "#lib/server/error-issue-status.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { errorProjectSettingsSchema } from "#lib/server/validation/error-tracking.js";
import {
	ErrorTrackingService,
	EVENTS_KEPT_PER_ISSUE,
	EVENTS_PER_MINUTE,
	RETENTION_DAYS,
} from "#lib/services/error-tracking.service.js";

const logger = new Logger("ErrorTracking");

const SORT_KEYS = ["lastSeen", "firstSeen", "count"];

export const load = async ({ parent, url }) => {
	const { preferences, service } = await parent();
	const limits = {
		eventsKept: EVENTS_KEPT_PER_ISSUE,
		eventsPerMinute: EVENTS_PER_MINUTE,
		retentionDays: RETENTION_DAYS,
	};
	if (service.previewParentId) {
		return {
			issues: null,
			limits,
			parentId: service.previewParentId,
			project: null,
		};
	}
	const project = await ErrorProjectDTO.getForService(service.id);
	if (!project) {
		return { issues: null, limits, parentId: null, project: null };
	}
	const query = parseListQuery(
		url,
		{ filterKeys: ["status"], sortKeys: SORT_KEYS },
		preferences.perPage,
	);
	const [issues, dsns, sourceMaps] = await Promise.all([
		ErrorIssueDTO.listPaged(service.id, query),
		ErrorTrackingService.dsns(project.toJSON(), url.origin),
		ErrorSourceMapDTO.releases(service.id),
	]);
	return {
		dsns,
		filtered: query.active,
		issues,
		limits,
		parentId: null,
		project: project.toJSON(),
		sourceMaps,
	};
};

async function ownService(serviceId: string, locals: App.Locals) {
	if (!locals.user) {
		redirectToSignIn();
	}
	return await ServiceDTO.get(serviceId);
}

export const actions = {
	enable: async ({ params, locals }) => {
		const svc = await ownService(params.serviceId, locals);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		if (svc.toJSON().previewParentId) {
			return fail(400, {
				error: "Previews and canaries report to their parent's project.",
			});
		}
		const project = await ErrorProjectDTO.getForService(svc.id);
		if (project) {
			await project.update({ enabled: true });
		} else {
			await ErrorProjectDTO.create(svc.id);
		}
		logger.info(
			`Error tracking enabled: service=${svc.id} user=${locals.user?.id}`,
		);
		return { enabled: true };
	},

	disable: async ({ params, locals }) => {
		const svc = await ownService(params.serviceId, locals);
		const project = svc ? await ErrorProjectDTO.getForService(svc.id) : null;
		if (!project) {
			return fail(404, { error: "Error tracking isn't set up." });
		}
		await project.update({ enabled: false });
		logger.info(
			`Error tracking disabled: service=${project.serviceId} user=${locals.user?.id}`,
		);
		return { enabled: false };
	},

	settings: async ({ request, params, locals }) => {
		const svc = await ownService(params.serviceId, locals);
		const project = svc ? await ErrorProjectDTO.getForService(svc.id) : null;
		if (!project) {
			return fail(404, { error: "Error tracking isn't set up." });
		}
		const result = errorProjectSettingsSchema.safeParse(
			Object.fromEntries(await request.formData()),
		);
		if (!result.success) {
			return fail(400, { errors: result.error.flatten().fieldErrors });
		}
		await project.update(result.data);
		logger.info(
			`Error tracking settings saved: service=${project.serviceId} injectEnv=${result.data.injectEnv} internalDsn=${result.data.internalDsn} user=${locals.user?.id}`,
		);
		return { success: true };
	},

	rotateKey: async ({ params, locals }) => {
		const svc = await ownService(params.serviceId, locals);
		const project = svc ? await ErrorProjectDTO.getForService(svc.id) : null;
		if (!project) {
			return fail(404, { error: "Error tracking isn't set up." });
		}
		await project.rotateKey();
		logger.info(
			`Error tracking key rotated: service=${project.serviceId} user=${locals.user?.id}`,
		);
		return { success: true };
	},

	deleteSourceMaps: async ({ request, params, locals }) => {
		const svc = await ownService(params.serviceId, locals);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const release = String((await request.formData()).get("release") ?? "");
		if (!release) {
			return fail(400, { error: "Pick a release." });
		}
		const deleted = await ErrorSourceMapDTO.deleteRelease(svc.id, release);
		logger.info(
			`Source maps deleted: service=${svc.id} release=${release} files=${deleted} user=${locals.user?.id}`,
		);
		return { deleted };
	},

	status: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await changeIssueStatus(
			params.serviceId,
			await request.formData(),
			locals.user.id,
		);
	},
};
