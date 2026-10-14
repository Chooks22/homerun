import { fail, redirect } from "@sveltejs/kit";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { parseWorkstationPreset } from "#lib/server/workstation-form.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";
import { resolve } from "$app/paths";

export const load = async ({ parent }) => {
	const { user } = await parent();
	const [hosts, gitProviders] = await Promise.all([
		RemoteHostDTO.list(),
		connectedGitProviders(user.id),
	]);
	return {
		agentHosts: hosts
			.filter((host) => host.kind === "agent")
			.map((host) => ({ id: host.id, name: host.name })),
		gitProviders,
	};
};

export const actions = {
	create: async ({ locals, request }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const result = parseWorkstationPreset(await request.formData());
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		let presetId: string;
		try {
			presetId = (
				await WorkstationSettingsService.createPreset(
					locals.user.id,
					result.parsed,
				)
			).id;
		} catch (error) {
			if (error instanceof WorkstationSettingsError) {
				return fail(error.status, { error: error.message });
			}
			throw error;
		}
		redirect(
			303,
			resolve("/(protected)/workstations/presets/[presetId]", {
				presetId,
			}),
		);
	},
};
