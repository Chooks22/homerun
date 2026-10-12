import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import {
	generateWorkstationPassword,
	parseNewWorkstation,
} from "#lib/server/workstation-form.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { slugify, uniqueSlug } from "#lib/slug.js";
import { resolve } from "$app/paths";

const logger = new Logger("Workstation");

export const load = async ({ parent }) => {
	await parent();
	const hosts = await RemoteHostDTO.list();
	return {
		agentHosts: hosts
			.filter((host) => host.kind === "agent")
			.map((host) => ({ id: host.id, name: host.name })),
		baseDomain: config.baseDomain,
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
		const { name, remoteHostId, ...settings } = result.parsed;
		if (remoteHostId) {
			const host = await RemoteHostDTO.get(remoteHostId);
			if (host?.kind !== "agent") {
				return fail(400, {
					error: "Workstations run on this server or on an agent host.",
				});
			}
		}
		const slug = await uniqueSlug(
			slugify(name) || "workstation",
			async (candidate) =>
				(await WorkstationDTO.slugTaken(candidate)) ||
				(await ServiceDTO.slugTaken(candidate)),
		);
		const ws = await WorkstationDTO.create({
			...settings,
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
