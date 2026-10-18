import { error, fail } from "@sveltejs/kit";
import { config, serviceDomain } from "#lib/config.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { parseDotEnv } from "#lib/env-parse.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import {
	branchPatternProblem,
	parseBranchPatterns,
} from "#lib/preview-branches.js";
import { parseLoginWallForm } from "#lib/server/login-wall-form.js";
import {
	loginWallAvailability,
	loginWallOptions,
} from "#lib/server/login-wall-options.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	defaultHostname,
	previewDomainTemplateProblem,
} from "#lib/service-domains.js";
import { GitWebhookService } from "#lib/services/git-webhook.service.js";
import { PreviewService } from "#lib/services/preview.service.js";
import {
	ServiceSettingsError,
	ServiceSettingsService,
} from "#lib/services/service-settings.service.js";

const logger = new Logger("Previews");

export const load = async ({ params }) => {
	const svc = await ServiceDTO.get(params.serviceId);
	if (!svc) {
		error(404, "Service not found");
	}
	const stack = svc.stackId ? await StackDTO.get(svc.stackId) : null;
	return {
		defaultPreviewHostname: defaultHostname(
			`${svc.slug}-pr-<n>`,
			stack?.slug,
			serviceDomain(),
		),
		...(await loginWallOptions()),
		previewAccess: svc.previewAccessPolicy,
		previews: await PreviewService.list(svc),
		pushWebhook: await GitWebhookService.describe(svc),
	};
};

/** The service behind a previews action, when it isn't itself a preview. */
async function previewParent(serviceId: string) {
	const svc = await ServiceDTO.get(serviceId);
	return svc && !svc.toJSON().previewParentId ? svc : null;
}

export const actions = {
	updatePreviewAccess: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await previewParent(params.serviceId);
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
		const saved = await ServiceSettingsService.save(
			svc,
			{
				previewAuthAllowedEmails: policy.authAllowedEmails,
				previewAuthAllowedGroups: policy.authAllowedGroups,
				previewAuthAllowedUserIds: policy.authAllowedUserIds,
				previewAuthProviders: policy.authProviders,
				previewAuthRequired: policy.authRequired,
			},
			{
				hostAccess: can(locals.permissions, "system", "write"),
				userId: locals.user.id,
			},
		);
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { authError: saved.message });
		}
		logger.info(
			`Preview access updated: service=${svc.id} authRequired=${policy.authRequired} methods=${
				policy.authProviders.join("|") || "none"
			} user=${locals.user.id}`,
		);
		return { authSuccess: true };
	},

	updatePreviews: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await previewParent(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const previewsEnabled = formData.get("previewsEnabled") === "on";
		const previewDefaultDomain = formData.get("previewDefaultDomain") === "on";
		const template = String(formData.get("previewDomainTemplate") ?? "")
			.trim()
			.toLowerCase();
		const values = Object.fromEntries(formData);
		const problem = template ? previewDomainTemplateProblem(template) : null;
		if (problem) {
			return fail(400, {
				errors: { previewDomainTemplate: [problem] },
				values,
			});
		}
		const include = parseBranchPatterns(
			String(formData.get("previewBranchInclude") ?? ""),
		);
		const exclude = parseBranchPatterns(
			String(formData.get("previewBranchExclude") ?? ""),
		);
		const includeProblem = include.map(branchPatternProblem).find(Boolean);
		const excludeProblem = exclude.map(branchPatternProblem).find(Boolean);
		if (includeProblem || excludeProblem) {
			return fail(400, {
				errors: {
					...(includeProblem ? { previewBranchInclude: [includeProblem] } : {}),
					...(excludeProblem ? { previewBranchExclude: [excludeProblem] } : {}),
				},
				values,
			});
		}
		if (!(template || previewDefaultDomain)) {
			return fail(400, {
				errors: {
					previewDomainTemplate: [
						"Set a domain template, or keep the default hostname: a preview needs at least one.",
					],
				},
				values,
			});
		}

		const saved = await ServiceSettingsService.save(
			svc,
			{
				previewBranchExclude: exclude,
				previewBranchInclude: include,
				previewCopyVolumes: formData.get("previewCopyVolumes") === "on",
				previewDefaultDomain,
				previewDomainTemplate: template || null,
				previewEnvOverrides: Object.fromEntries(
					parseDotEnv(String(formData.get("previewEnvOverrides") ?? "")).map(
						(row) => [row.key, row.value],
					),
				),
				previewInheritEnv: formData.get("previewInheritEnv") === "on",
				previewUptimeEnabled: formData.get("previewUptimeEnabled") === "on",
				previewsEnabled,
			},
			{
				hostAccess: can(locals.permissions, "system", "write"),
				userId: locals.user.id,
			},
		);
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { error: saved.message, values });
		}
		const { filteredOut } = saved;

		logger.info(
			`Preview settings updated: service=${svc.id} enabled=${previewsEnabled} template=${template || "-"} user=${locals.user.id}`,
		);
		return { filteredOut, success: true };
	},

	deployOpen: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await previewParent(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		if (svc.buildSource !== "git") {
			return fail(400, {
				error: "Only a service built from git can list its open pull requests.",
			});
		}
		if (!svc.toJSON().previewsEnabled) {
			return fail(400, { error: "Turn pull request previews on first." });
		}
		try {
			return await GitWebhookService.deployOpenPullRequests(svc);
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},

	redeploy: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await previewParent(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const previewId = String((await request.formData()).get("previewId"));
		try {
			await PreviewService.redeploy(svc, previewId);
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return { success: true };
	},

	delete: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await previewParent(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const previewId = String((await request.formData()).get("previewId"));
		try {
			await PreviewService.delete(svc, previewId);
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return { success: true };
	},
};
