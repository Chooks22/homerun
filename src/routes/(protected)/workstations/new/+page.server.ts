import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { parseNewWorkstation } from "#lib/server/workstation-form.js";
import {
	WorkstationSettingsError,
	WorkstationSettingsService,
} from "#lib/services/workstation/settings.js";
import { resolve } from "$app/paths";

export const load = async ({ parent, url }) => {
	const { user } = await parent();
	const [hosts, gitProviders, presets] = await Promise.all([
		RemoteHostDTO.list(),
		connectedGitProviders(user.id),
		WorkstationPresetDTO.listForUser(user.id),
	]);
	const presetId = url.searchParams.get("preset");
	return {
		agentHosts: hosts
			.filter((host) => host.kind === "agent")
			.map((host) => ({ id: host.id, name: host.name })),
		baseDomain: config.baseDomain,
		gitProviders,
		preset: presets.find((p) => p.id === presetId)?.toJSON() ?? null,
		presets: presets.map((p) => ({
			description: p.toJSON().description,
			id: p.id,
			name: p.name,
		})),
	};
};

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const result = parseNewWorkstation(await request.formData());
		if ("error" in result) {
			return fail(400, { error: result.error });
		}
		let workstationId: string;
		try {
			workstationId = (
				await WorkstationSettingsService.create(locals.user.id, result.parsed)
			).id;
		} catch (error) {
			if (error instanceof WorkstationSettingsError) {
				return fail(error.status, { error: error.message });
			}
			throw error;
		}
		redirect(
			303,
			resolve("/(protected)/workstations/[workstationId]", {
				workstationId,
			}),
		);
	},
};
