import { fail, redirect } from "@sveltejs/kit";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { statusPageSchema } from "#lib/server/validation/status-page.js";
import {
	StatusPageSettingsError,
	StatusPageSettingsService,
} from "#lib/services/status-page-settings.service.js";
import {
	picksFromForm,
	statusPageServiceOptions,
} from "#lib/status-page-members.js";
import { resolve } from "$app/paths";

export const load = async ({ parent }) => {
	await parent();
	const [stacks, services] = await Promise.all([
		StackDTO.list(),
		ServiceDTO.list(),
	]);
	return {
		stacks: stacks.map((p) => ({ id: p.id, name: p.name })),
		services: statusPageServiceOptions(services.map((svc) => svc.toJSON())),
	};
};

export const actions = {
	default: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const form = await request.formData();
		const parsed = statusPageSchema.safeParse(Object.fromEntries(form));
		if (!parsed.success) {
			return fail(400, {
				errors: parsed.error.flatten().fieldErrors,
			});
		}
		try {
			const page = await StatusPageSettingsService.create(
				{
					...parsed.data,
					domains: String(form.get("domains") ?? "").split(/[\s,]+/),
					picks: picksFromForm(form),
					stackId: parsed.data.stackId || null,
				},
				locals.user.id,
			);
			throw redirect(303, `${resolve("status-pages")}/${page.id}`);
		} catch (err) {
			if (err instanceof StatusPageSettingsError) {
				return fail(400, { errors: { [err.field]: [err.message] } });
			}
			throw err;
		}
	},
};
