import { error, fail, redirect } from "@sveltejs/kit";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { StatusPageDTO } from "#lib/dto/status-page-dto.js";
import { BEAT_WINDOW, UptimeCheckDTO } from "#lib/dto/uptime-check-dto.js";
import { dashboardOrigin } from "#lib/server/canonical-origin.js";
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

export const load = async ({ params, parent, request, url }) => {
	await parent();

	const page = await StatusPageDTO.get(params.statusPageId);
	if (!page) {
		error(404, "Status page not found");
	}

	const picks = await page.picks();
	const [stacks, allServices, shown] = await Promise.all([
		StackDTO.list(),
		ServiceDTO.list(),
		page.members(picks),
	]);
	const beats = await Promise.all(
		shown.map(async (member) => ({
			beats: (await UptimeCheckDTO.beats(member.id, "internal")).map(
				(beat) => ({
					checkedAt: beat.checkedAt,
					detail: beat.detail,
					ok: beat.ok,
				}),
			),
			childOf: member.childOf,
			id: member.id,
			name: member.name,
		})),
	);

	return {
		dashboardOrigin: dashboardOrigin(request, url),
		beatWindow: BEAT_WINDOW,
		picks,
		stacks: stacks.map((p) => ({ id: p.id, name: p.name })),
		services: statusPageServiceOptions(allServices.map((svc) => svc.toJSON())),
		statusPage: page.toJSON(),
		tracked: beats,
	};
};

export const actions = {
	update: async ({ locals, params, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const page = await StatusPageDTO.get(params.statusPageId);
		if (!page) {
			return fail(404, { error: "Status page not found." });
		}

		const form = await request.formData();
		const parsed = statusPageSchema.safeParse(Object.fromEntries(form));
		if (!parsed.success) {
			return fail(400, {
				errors: parsed.error.flatten().fieldErrors,
			});
		}
		try {
			await StatusPageSettingsService.update(page, {
				...parsed.data,
				domains: String(form.get("domains") ?? "").split(/[\s,]+/),
				picks: picksFromForm(form),
				stackId: parsed.data.stackId || null,
			});
		} catch (err) {
			if (err instanceof StatusPageSettingsError) {
				return fail(400, { errors: { [err.field]: [err.message] } });
			}
			throw err;
		}
		return { success: true };
	},

	delete: async ({ locals, params }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const page = await StatusPageDTO.get(params.statusPageId);
		if (!page) {
			return fail(404, { error: "Status page not found." });
		}
		await StatusPageSettingsService.delete(page);
		throw redirect(303, resolve("status-pages"));
	},
};
