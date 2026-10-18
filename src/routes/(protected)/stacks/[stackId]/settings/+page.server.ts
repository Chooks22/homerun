import { error, fail, redirect } from "@sveltejs/kit";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { listIconLibrary } from "#lib/server/icon-library.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { WorkloadDetachError } from "#lib/services/docker/workload-removal.js";
import {
	ServiceLifecycleService,
	StackBusyError,
} from "#lib/services/service-lifecycle.service.js";
import {
	StackSettingsError,
	StackSettingsService,
} from "#lib/services/stack-settings.service.js";
import { descendantIds, stackPath } from "#lib/stack-tree.js";
import { resolve } from "$app/paths";

const logger = new Logger("Stacks");

export const load = async ({ params, parent }) => {
	await parent();
	const stack = await StackDTO.get(params.stackId);
	if (!stack) {
		error(404, "Stack not found");
	}
	const [all, icons, deleteOverview] = await Promise.all([
		StackDTO.list(),
		listIconLibrary(),
		ServiceLifecycleService.stackDeleteOverview(stack),
	]);
	const stacks = all.map((s) => ({
		id: s.id,
		name: s.name,
		parentId: s.parentId,
		slug: s.slug,
	}));
	const excluded = new Set([
		params.stackId,
		...descendantIds(params.stackId, stacks),
	]);
	return {
		deleteOverview,
		icons,
		parentOptions: stacks
			.filter((s) => !excluded.has(s.id))
			.map((s) => ({ id: s.id, path: stackPath(s.id, stacks) }))
			.sort((a, b) => a.path.localeCompare(b.path)),
	};
};

export const actions = {
	updateIcon: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const stack = await StackDTO.get(params.stackId);
		if (!stack) {
			return fail(404, { error: "Stack not found." });
		}
		const icon = String((await request.formData()).get("icon") ?? "");
		try {
			await StackSettingsService.apply(stack, { icon });
		} catch (err) {
			if (err instanceof StackSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		logger.info(
			`Stack icon updated: stack=${stack.id} icon=${icon.startsWith("data:") ? "upload" : icon || "none"} user=${locals.user.id}`,
		);
		return { success: true };
	},
	move: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const stack = await StackDTO.get(params.stackId);
		if (!stack) {
			return fail(404, { error: "Stack not found." });
		}

		const parentId =
			((await request.formData()).get("parentId") as string | null) || null;

		try {
			await StackSettingsService.apply(stack, { parentId });
		} catch (err) {
			if (err instanceof StackSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		logger.info(
			`Stack moved: stack=${stack.id} parent=${parentId ?? "none"} user=${locals.user.id}`,
		);
		return { success: true };
	},
	delete: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const stack = await StackDTO.get(params.stackId);
		if (!stack) {
			return fail(404, { error: "Stack not found." });
		}
		const formData = await request.formData();
		const force = formData.get("force") === "true";
		const deleteVolumes = formData.get("deleteVolumes") === "true";
		try {
			await ServiceLifecycleService.deleteStack(stack, {
				deleteVolumes,
				force,
			});
		} catch (err) {
			if (err instanceof WorkloadDetachError || err instanceof StackBusyError) {
				return fail(409, { detachFailed: true, error: err.message });
			}
			throw err;
		}

		logger.info(
			`Stack deleted: stack=${params.stackId} force=${force} deleteVolumes=${deleteVolumes} user=${locals.user.id}`,
		);
		redirect(303, resolve("stacks"));
	},
	rename: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const stack = await StackDTO.get(params.stackId);
		if (!stack) {
			return fail(404, { error: "Stack not found." });
		}
		const formData = await request.formData();
		try {
			await StackSettingsService.apply(stack, {
				description: formData.get("description") as string | null,
				name: (formData.get("name") as string | null) ?? "",
				slug: (formData.get("slug") as string | null)?.trim() ?? "",
			});
		} catch (err) {
			if (err instanceof StackSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}

		logger.info(
			`Stack renamed: stack=${params.stackId} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
