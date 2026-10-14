import { fail, redirect } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import { domainHosts, serviceHostnames } from "#lib/service-domains.js";
import { DeploymentService } from "#lib/services/deploy.service.js";
import {
	InstanceSettingsError,
	InstanceSettingsService,
} from "#lib/services/instance-settings.service.js";
import { certificateCovers } from "#lib/tls-certificate.js";
import { resolve } from "$app/paths";

const logger = new Logger("InstanceSettings");

/** The deployed services with a hostname the certificate covers, which need a redeploy to stop asking Let's Encrypt for it. */
async function coveredServices(names: string[]) {
	if (names.length === 0) {
		return [];
	}
	const [services, stacks] = await Promise.all([
		ServiceDTO.list(),
		StackDTO.list(),
	]);
	const slugs = new Map(stacks.map((stack) => [stack.id, stack.slug]));
	return services.filter(
		(svc) =>
			(svc.containerId || svc.swarmServiceId) &&
			svc.dnsResolvable &&
			domainHosts(
				serviceHostnames(
					svc.toJSON(),
					svc.stackId ? slugs.get(svc.stackId) : null,
					config.baseDomain,
				),
			).some((host) => certificateCovers(names, host)),
	);
}

export const load = async () => {
	const settings = await InstanceSettingsDTO.get();
	const certificate = settings.instanceCertificate;
	const covered = await coveredServices(certificate?.names ?? []);
	return {
		behindPangolin: config.pangolinEnabled,
		certificate,
		coveredServices: covered.map((svc) => ({ id: svc.id, name: svc.name })),
		dynamicConfigDir: config.traefik.dynamicConfigDir ?? null,
	};
};

/** The signed-in user's id, sending a signed-out caller to the sign-in page. */
function signedInUserId(locals: App.Locals): string {
	if (!locals.user) {
		throw redirect(302, resolve("auth/sign-in"));
	}
	return locals.user.id;
}

export const actions = {
	install: async ({ request, locals }) => {
		const userId = signedInUserId(locals);
		const formData = await request.formData();
		const cert = String(formData.get("cert") ?? "").trim();
		const key = String(formData.get("key") ?? "").trim();
		let names: string[];
		try {
			names = await InstanceSettingsService.installCertificate(
				cert,
				key,
				userId,
			);
		} catch (err) {
			if (err instanceof InstanceSettingsError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		return { installed: names.join(", "), success: true };
	},

	remove: async ({ locals }) => {
		await InstanceSettingsService.removeCertificate(signedInUserId(locals));
		return { removed: true, success: true };
	},

	redeployCovered: async ({ locals }) => {
		const userId = signedInUserId(locals);
		const settings = await InstanceSettingsDTO.get();
		const services = await coveredServices(
			settings.instanceCertificate?.names ?? [],
		);
		for (const svc of services) {
			// oxlint-disable-next-line no-await-in-loop -- each enqueue writes its own deployment row, the queue serialises them anyway
			await DeploymentService.enqueueDeploy({ svc, userId });
		}
		logger.info(
			`Redeploy queued for ${services.length} service(s) the instance certificate covers: user=${userId}`,
		);
		return { redeployed: services.length, success: true };
	},
};
