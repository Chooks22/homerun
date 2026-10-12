import { redirect } from "@sveltejs/kit";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { can } from "#lib/permissions.js";
import { resolve } from "$app/paths";

export const load = async ({ locals, parent }) => {
	await parent();
	if (!can(locals.permissions, "settings", "read")) {
		throw redirect(302, resolve("/(protected)/monitoring"));
	}
	return {
		canWrite: can(locals.permissions, "settings", "write"),
		crowdsecConfigured: Boolean(
			(await InstanceSettingsDTO.get()).crowdsecCredentials(),
		),
	};
};
