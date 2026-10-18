import { fail } from "@sveltejs/kit";
import { IacProjectDTO } from "#lib/dto/iac-project-dto.js";
import { IacStateVersionDTO } from "#lib/dto/iac-state-version-dto.js";
import { usesHttpBackend } from "#lib/iac/tools.js";
import { httpBackendBlock, pulumiLoginCommand } from "#lib/iac-state.js";
import { highlightCode } from "#lib/server/shiki.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { IacStateService } from "#lib/services/iac-state.service.js";

function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export const load = async ({ parent }) => {
	const { origin, project, store } = await parent();
	if (!usesHttpBackend(project.tool)) {
		const pulumi = store
			? pulumiLoginCommand({
					bucket: project.bucket,
					endpoint: store.endpoint,
					prefix: project.prefix,
					region: store.region,
					slug: project.slug,
				})
			: null;
		return {
			backend: null,
			history: [],
			lock: null,
			pulumi: pulumi
				? { code: pulumi, html: await highlightCode(pulumi, "shellscript") }
				: null,
		};
	}
	const row = await IacProjectDTO.get(project.id);
	const [history, lock] = await Promise.all([
		IacStateVersionDTO.history(project.id),
		row ? row.lockView() : Promise.resolve(null),
	]);
	const backend = httpBackendBlock(
		`${origin}/api/v1/iac/projects/${project.id}`,
	);
	return {
		backend: { code: backend, html: await highlightCode(backend, "hcl") },
		history,
		lock,
		pulumi: null,
	};
};

export const actions = {
	forceUnlock: async ({ params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const project = await IacProjectDTO.get(params.projectId);
		if (!project) {
			return fail(404, { error: "That IaC project doesn't exist." });
		}
		await IacStateService.unlock(project, null, true);
		return { success: true };
	},

	rollback: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const project = await IacProjectDTO.get(params.projectId);
		if (!project) {
			return fail(404, { error: "That IaC project doesn't exist." });
		}
		const versionId = String((await request.formData()).get("versionId") ?? "");
		try {
			const version = await IacStateService.rollback(
				project,
				versionId,
				locals.user.id,
			);
			return { serial: version.serial, success: true };
		} catch (cause) {
			return fail(400, { error: reason(cause) });
		}
	},
};
