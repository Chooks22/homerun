import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import { Logger } from "#lib/logger.js";
import { connectedGitProviders } from "#lib/server/git-connections.js";
import { hostnameOwner } from "#lib/server/hostname-owner.js";
import {
	generateWorkstationPassword,
	parseNewWorkstation,
} from "#lib/server/workstation-form.js";
import { agentHostProblem } from "#lib/server/workstation-presets.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { slugify, uniqueSlug } from "#lib/slug.js";
import { defaultWorkstationDomain } from "#lib/workstations.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

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
		const { domain, name, remoteHostId, ...settings } = result.parsed;
		const hostProblem = await agentHostProblem(remoteHostId);
		if (hostProblem) {
			return fail(400, { error: hostProblem });
		}
		const slug = await uniqueSlug(slugify(name) || "workstation", (candidate) =>
			WorkstationDTO.slugTaken(candidate),
		);
		const hostname =
			domain ?? defaultWorkstationDomain(slug, config.baseDomain);
		const owner = await hostnameOwner(hostname);
		if (owner) {
			return fail(409, {
				error: `${hostname} is already routed to ${owner}. Pick another domain for the workstation.`,
			});
		}
		const ws = await WorkstationDTO.create({
			...settings,
			domain: hostname,
			name,
			passwordEnc: encryptSecret(generateWorkstationPassword()),
			remoteHostId,
			slug,
			userId: locals.user.id,
		});
		logger.info(
			`Workstation created: workstation=${ws.id} host=${remoteHostId ?? "local"} user=${locals.user.id}`,
		);
		await WorkstationService.start(ws).catch((error: unknown) => {
			logger.warn(
				`Workstation created but didn't start: workstation=${ws.id}`,
				error,
			);
		});
		redirect(
			303,
			resolve("/(protected)/workstations/[workstationId]", {
				workstationId: ws.id,
			}),
		);
	},
};
