import { fail, redirect } from "@sveltejs/kit";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { Logger } from "#lib/logger.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { parseWorkstationPreset } from "#lib/server/workstation-form.js";
import { agentHostProblem } from "#lib/server/workstation-presets.js";
import { resolve } from "$app/paths";

const logger = new Logger("WorkstationPreset");

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
		const hostProblem = await agentHostProblem(result.parsed.remoteHostId);
		if (hostProblem) {
			return fail(400, { error: hostProblem });
		}
		const preset = await WorkstationPresetDTO.create(
			locals.user.id,
			result.parsed,
		);
		logger.info(
			`Workstation preset created: preset=${preset.id} user=${locals.user.id}`,
		);
		redirect(
			303,
			resolve("/(protected)/workstations/presets/[presetId]", {
				presetId: preset.id,
			}),
		);
	},
};
