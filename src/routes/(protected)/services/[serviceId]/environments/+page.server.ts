import { error, fail } from "@sveltejs/kit";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { environmentFormInput } from "#lib/environment-form.js";
import { Logger } from "#lib/logger.js";
import { ENVIRONMENT_PRESETS } from "#lib/release-channels.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	EnvironmentError,
	EnvironmentService,
} from "#lib/services/environment.service.js";
import { PreviewService } from "#lib/services/preview.service.js";
import { ReleaseChannelService } from "#lib/services/release-channel.service.js";

const logger = new Logger("Environments");

export const load = async ({ params, parent }) => {
	const { service } = await parent();
	const parentService = service.previewParentId
		? null
		: await ServiceDTO.get(params.serviceId);
	if (!parentService) {
		return { canary: null, environments: [], presets: [], previews: [] };
	}
	const isGit = service.buildSource === "git";
	const [channels, previews, environments] = await Promise.all([
		isGit ? ReleaseChannelService.status(parentService) : null,
		PreviewService.list(parentService),
		EnvironmentService.list(parentService),
	]);
	return {
		canary: channels?.canary ?? null,
		environments: environments.map((entry) => {
			const row = entry.toJSON();
			return {
				currentStatus: row.currentStatus,
				defaultDomainEnabled: row.defaultDomainEnabled,
				dnsResolvable: row.dnsResolvable,
				domains: row.domains,
				environmentName: row.environmentName,
				id: row.id,
				name: row.name,
				primaryDomain: row.primaryDomain,
				ref: isGit ? (row.gitRef ?? "main") : row.tag,
				slug: row.slug,
			};
		}),
		presets: [...ENVIRONMENT_PRESETS],
		previews,
	};
};

/** The service the environments action works on, refusing one that is itself an environment, preview or canary. */
async function environmentParent(serviceId: string) {
	const svc = await ServiceDTO.get(serviceId);
	if (!svc) {
		error(404, "Service not found");
	}
	return svc.toJSON().previewParentId ? null : svc;
}

export const actions = {
	createEnvironment: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await environmentParent(params.serviceId);
		if (!svc) {
			return fail(400, {
				error: "Environments are created on the service itself.",
			});
		}
		const formData = await request.formData();
		const parsed = environmentFormInput(formData);
		if ("error" in parsed) {
			return fail(400, { error: parsed.error });
		}
		const name = String(formData.get("name") ?? "")
			.trim()
			.toLowerCase();
		try {
			await EnvironmentService.create(svc, name, parsed.input, {
				deploy: formData.get("deploy") === "on",
				userId: locals.user.id,
			});
		} catch (err) {
			if (err instanceof EnvironmentError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		logger.info(
			`Environment created from the dashboard: service=${svc.id} name=${name} user=${locals.user.id}`,
		);
		return { created: name, deployed: formData.get("deploy") === "on" };
	},

	updateEnvironment: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await environmentParent(params.serviceId);
		if (!svc) {
			return fail(400, {
				error: "Environments are edited on the service itself.",
			});
		}
		const formData = await request.formData();
		const parsed = environmentFormInput(formData);
		if ("error" in parsed) {
			return fail(400, { error: parsed.error });
		}
		try {
			await EnvironmentService.update(
				svc,
				String(formData.get("environmentId") ?? ""),
				parsed.input,
			);
		} catch (err) {
			if (err instanceof EnvironmentError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { success: true };
	},

	deleteEnvironment: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await environmentParent(params.serviceId);
		if (!svc) {
			return fail(400, {
				error: "Environments are deleted from the service itself.",
			});
		}
		try {
			await EnvironmentService.delete(
				svc,
				String((await request.formData()).get("environmentId") ?? ""),
			);
		} catch (err) {
			if (err instanceof EnvironmentError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		logger.info(
			`Environment deleted from the dashboard: service=${svc.id} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
