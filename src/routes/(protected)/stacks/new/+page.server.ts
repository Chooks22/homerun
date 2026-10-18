import { fail, redirect } from "@sveltejs/kit";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	StackSettingsError,
	StackSettingsService,
} from "#lib/services/stack-settings.service.js";
import { stackPath } from "#lib/stack-tree.js";
import { resolve } from "$app/paths";

export const load = async ({ parent, url }) => {
	await parent();
	const parentId = url.searchParams.get("parentId");
	const stack = parentId ? await StackDTO.get(parentId) : null;
	if (!stack) {
		return { parent: null };
	}
	const all = (await StackDTO.list()).map((s) => ({
		id: s.id,
		name: s.name,
		parentId: s.parentId,
		slug: s.slug,
	}));
	return {
		parent: { id: stack.id, path: stackPath(stack.id, all), slug: stack.slug },
	};
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const parentId = (formData.get("parentId") as string | null) || null;
		try {
			await StackSettingsService.create(
				{
					description: formData.get("description") as string | null,
					name: (formData.get("name") as string | null) ?? "",
					parentId,
					slug: (formData.get("slug") as string | null)?.trim() ?? "",
				},
				locals.user.id,
			);
		} catch (err) {
			if (err instanceof StackSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		redirect(
			303,
			parentId
				? resolve("/(protected)/stacks/[stackId]", { stackId: parentId })
				: resolve("stacks"),
		);
	},
};
