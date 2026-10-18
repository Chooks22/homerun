import { fail } from "@sveltejs/kit";
import { buildCacheChoice } from "#lib/build-cache.js";
import { BuildCacheRegistryDTO } from "#lib/dto/build-cache-registry-dto.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { watchPathPatterns } from "#lib/server/validation/api.js";
import {
	type UpdateSourceInput,
	updateSourceSchema,
} from "#lib/server/validation/service.js";
import { GitWebhookService } from "#lib/services/git-webhook.service.js";
import { ImageVersionService } from "#lib/services/image-version.service.js";
import { PreviewService } from "#lib/services/preview.service.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { parseWatchPaths } from "#lib/watch-paths.js";

const logger = new Logger("Services");

export const load = async ({ parent, params }) => {
	const { user } = await parent();
	const svc = await ServiceDTO.get(params.serviceId);
	const [gitProviders, cacheRegistries, buildServers] = await Promise.all([
		connectedGitProviders(user.id),
		BuildCacheRegistryDTO.list(),
		RemoteHostDTO.listBuildServers(),
	]);

	const previewParentId = svc?.toJSON().previewParentId;
	const previewParent = previewParentId
		? await ServiceDTO.get(previewParentId)
		: null;

	return {
		previewOf: previewParent
			? {
					canary: Boolean(svc?.toJSON().channelCanary),
					id: previewParent.id,
					name: previewParent.name,
				}
			: null,
		pushWebhook: svc ? await GitWebhookService.describe(svc) : null,
		buildCacheRegistries: cacheRegistries.map((r) => r.toJSON()),
		buildServers: buildServers.map((r) => r.toJSON()),
		connectedGitProviders: gitProviders,
	};
};

function gitTriggerPatch(formData: FormData, isGitBuild: boolean) {
	return {
		gitPollEnabled: isGitBuild && formData.get("gitPollEnabled") === "on",
	};
}

function statusCheckPatch(formData: FormData, isGitBuild: boolean) {
	const names = formData
		.getAll("requiredStatusChecks")
		.map((value) => String(value).trim())
		.filter((value) => value.length > 0 && value.length <= 200);
	return {
		requireStatusChecks:
			isGitBuild && formData.get("requireStatusChecks") === "on",
		requiredStatusChecks: [...new Set(names)].slice(0, 50),
	};
}

/**
 * The watch and ignore paths the form posts, one glob per line, or field
 * errors. A field the form didn't render keeps the stored list, and an
 * image-built service has none.
 */
function watchPathsPatch(
	formData: FormData,
	isGitBuild: boolean,
	stored: { gitIgnorePaths: string[]; gitWatchPaths: string[] },
):
	| { patch: { gitIgnorePaths: string[]; gitWatchPaths: string[] } }
	| { errors: Record<string, string[]> } {
	if (!isGitBuild) {
		return { patch: { gitIgnorePaths: [], gitWatchPaths: [] } };
	}
	const patch = {
		gitIgnorePaths: stored.gitIgnorePaths,
		gitWatchPaths: stored.gitWatchPaths,
	};
	const errors: Record<string, string[]> = {};
	for (const field of ["gitWatchPaths", "gitIgnorePaths"] as const) {
		const text = formData.get(field);
		if (text === null) {
			continue;
		}
		const result = watchPathPatterns.safeParse(parseWatchPaths(String(text)));
		if (result.success) {
			patch[field] = result.data;
		} else {
			errors[field] = [result.error.issues[0]?.message ?? "Invalid paths."];
		}
	}
	return Object.keys(errors).length > 0 ? { errors } : { patch };
}

interface BuildTargets {
	buildCacheRegistryId: string | null;
	buildServerRemoteHostId: string | null;
}

/**
 * Validates the chosen build server exists, returning field errors or
 * null. No cache registry is needed: without one the built image is streamed
 * back to this host. Both remote-host kinds (docker and agent) are real build servers,
 * see the worker's git-build step (internal/jobs) :
 * real, tested-in-review bug this replaced, a stale "docker only" leftover
 * from before that integration.
 */
async function checkBuildServer(
	targets: BuildTargets,
): Promise<Record<string, string[]> | null> {
	const { buildServerRemoteHostId } = targets;
	if (!buildServerRemoteHostId) {
		return null;
	}

	const buildServer = await RemoteHostDTO.get(buildServerRemoteHostId);
	if (!buildServer) {
		return { buildServerRemoteHostId: ["That build server wasn't found."] };
	}
	return null;
}

/** The image-source half of the update : git fields in git mode, image/tag otherwise. */
function sourcePatch(input: UpdateSourceInput, isGitBuild: boolean) {
	return {
		buildSource: input.buildSource,
		registryUrl: input.registryUrl || null,
		registryUsername: input.registryUsername || null,
		// Blank password field means "leave unchanged" : never overwrite a
		// stored credential with nothing just because the user didn't
		// retype it.
		...(input.registryPassword
			? { registryPasswordEnc: encryptSecret(input.registryPassword) }
			: {}),
		...(isGitBuild
			? {
					autoDeployOnPush: input.autoDeployOnPush,
					gitBakeFile: input.gitBakeFile || null,
					gitBuildTarget: input.gitBuildTarget || null,
					gitBuildContext: input.gitBuildContext || null,
					gitBuildMethod: input.gitBuildMethod,
					gitDockerfilePath: input.gitDockerfilePath || null,
					gitProviderId: (input.gitRepo && input.gitProviderId) || null,
					gitRef: input.gitRef || null,
					gitRepo: (input.gitProviderId && input.gitRepo) || null,
					gitUrl: input.gitUrl || null,
				}
			: {
					autoDeployOnPush: false,
					gitBakeFile: null,
					gitBuildTarget: null,
					gitBuildContext: null,
					gitBuildMethod: "dockerfile" as const,
					gitDockerfilePath: null,
					gitProviderId: null,
					gitRef: null,
					gitRepo: null,
					gitUrl: null,
					image: input.image,
					tag: input.tag,
				}),
	};
}

export const actions = {
	updateSource: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const result = updateSourceSchema.safeParse(Object.fromEntries(formData));
		if (!result.success) {
			return fail(400, {
				errors: result.error.flatten().fieldErrors,
				values: Object.fromEntries(formData),
			});
		}
		const input = result.data;
		const isGitBuild = input.buildSource === "git";
		const buildServerRemoteHostId = isGitBuild
			? input.buildServerRemoteHostId || null
			: null;
		const buildCache = buildCacheChoice(input);
		const { buildCacheRegistryId } = buildCache;

		const checks = statusCheckPatch(formData, isGitBuild);
		if (
			checks.requireStatusChecks &&
			checks.requiredStatusChecks.length === 0
		) {
			return fail(400, {
				errors: {
					requiredStatusChecks: [
						"Pick at least one check to require, or turn status checks off.",
					],
				},
				values: Object.fromEntries(formData),
			});
		}

		const watchPaths = watchPathsPatch(formData, isGitBuild, svc.toJSON());
		if ("errors" in watchPaths) {
			return fail(400, {
				errors: watchPaths.errors,
				values: Object.fromEntries(formData),
			});
		}

		const buildServerError = await checkBuildServer({
			buildCacheRegistryId,
			buildServerRemoteHostId,
		});
		if (buildServerError) {
			return fail(400, {
				errors: buildServerError,
				values: Object.fromEntries(formData),
			});
		}

		const previousWebhook = {
			gitProviderId: svc.gitProviderId,
			gitRepo: svc.gitRepo,
			gitWebhookId: svc.gitWebhookId,
			previewsEnabled: svc.toJSON().previewsEnabled,
		};
		const previousBuildSource = svc.buildSource;
		await svc.update({
			...buildCache,
			buildServerRemoteHostId,
			...checks,
			...gitTriggerPatch(formData, isGitBuild),
			...watchPaths.patch,
			previewReportGithub:
				isGitBuild && !svc.toJSON().previewParentId
					? formData.get("previewReportGithub") === "on"
					: svc.toJSON().previewReportGithub,
			...sourcePatch(input, isGitBuild),
		});
		await GitWebhookService.sync(svc, previousWebhook);
		if (previousBuildSource !== svc.buildSource) {
			await PreviewService.removeAll(svc);
		}

		logger.info(
			`Service source updated: service=${svc.id} buildSource=${input.buildSource} user=${locals.user.id}`,
		);
		return { success: true };
	},
	findPin: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			return { pin: await ImageVersionService.findPinCandidates(svc) };
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
	pin: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const formData = await request.formData();
		const local = formData.get("choice") === "local";
		const tag = String(
			(local ? formData.get("localTag") : formData.get("choice")) ?? "",
		).trim();
		try {
			await ImageVersionService.pin(svc, tag, { local });
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		logger.info(
			`Service pinned: service=${svc.id} tag=${tag} user=${locals.user.id}`,
		);
		return { tag };
	},
	unpin: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		await ImageVersionService.unpin(svc);
		return { tag: svc.tag };
	},
	updateWatch: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const formData = await request.formData();
		await ImageVersionService.setWatch(svc, {
			updateCheckEnabled: formData.get("updateCheckEnabled") === "on",
			updateTrialEnabled: formData.get("updateTrialEnabled") === "on",
		});
		return { success: true };
	},
	checkUpdates: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const state = await ImageVersionService.check(svc, { background: true });
		if (state?.error) {
			return fail(502, { error: state.error });
		}
		return { available: state?.available?.tag ?? null };
	},
	applyUpdate: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		try {
			await ImageVersionService.applyUpdate(svc, locals.user.id);
		} catch (err) {
			return fail(400, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return { tag: svc.tag };
	},
};
