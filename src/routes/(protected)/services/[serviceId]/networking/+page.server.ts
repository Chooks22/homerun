import { fail } from "@sveltejs/kit";
import { config } from "#lib/config.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import { can } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	parsePublishedPortsField,
	updatePortsSchema,
} from "#lib/server/validation/service.js";
import { normalizeDomain } from "#lib/service-domains.js";
import {
	DomainConflictError,
	ServiceSettingsError,
	ServiceSettingsService,
} from "#lib/services/service-settings.service.js";

const logger = new Logger("Services");

export const load = async ({ parent }) => {
	await parent();
	return { httpCacheAvailable: config.traefik.httpCache };
};

export const actions = {
	updateCache: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const raw = String(
			(await request.formData()).get("httpCacheTtl") ?? "",
		).trim();
		const ttl = raw === "" ? null : Number(raw);
		if (ttl !== null && !(Number.isInteger(ttl) && ttl >= 1 && ttl <= 86_400)) {
			return fail(400, {
				error: "Cache time must be a whole number of seconds, 1 to 86400.",
			});
		}
		await svc.update({ httpCacheTtl: ttl });
		logger.info(
			`Response cache updated: service=${svc.id} ttl=${ttl ?? "off"} user=${locals.user.id}`,
		);
		return { success: true };
	},

	updateDomains: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}
		const formData = await request.formData();
		const rawDomains = formData.getAll("domains").map(String);
		const rawPorts = formData.getAll("domainPorts").map(String);
		const rawStrips = formData.getAll("domainStripPaths").map(String);
		const stripPathDomains = rawDomains
			.filter((_, index) => rawStrips[index] === "on")
			.map(normalizeDomain);
		const domainPorts: Record<string, number> = {};
		for (const [index, raw] of rawDomains.entries()) {
			const domain = normalizeDomain(raw);
			const port = (rawPorts[index] ?? "").trim();
			if (!(port && domain)) {
				continue;
			}
			const value = Number(port);
			if (!Number.isInteger(value) || value < 1 || value > 65_535) {
				return fail(400, {
					error: `The port for ${domain} must be a number between 1 and 65535.`,
				});
			}
			domainPorts[domain] = value;
		}
		const saved = await ServiceSettingsService.save(
			svc,
			{
				defaultDomainEnabled: formData.get("defaultDomainEnabled") === "on",
				domainPorts,
				domains: rawDomains,
				primaryDomain: String(formData.get("primaryDomain") ?? ""),
				stripPathDomains,
				takeOverDomains: formData.get("takeOverDomains") === "on",
			},
			{
				hostAccess: can(locals.permissions, "system", "write"),
				userId: locals.user.id,
			},
		);
		if (saved instanceof DomainConflictError) {
			return fail(saved.status, {
				canTakeOver: saved.canTakeOver,
				conflicts: saved.conflicts.map((conflict) => ({
					entry: conflict.entry,
					owner: conflict.owner.label,
				})),
				error: saved.message,
			});
		}
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { error: saved.message });
		}
		logger.info(
			`Domains updated: service=${svc.id} domains=${svc.toJSON().domains.join(",")} defaultDomain=${svc.toJSON().defaultDomainEnabled} user=${locals.user.id}`,
		);
		return { success: true, takenOver: saved.takenOver };
	},

	updateSsl: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const cert = (formData.get("customSslCert") as string | null)?.trim();
		const key = (formData.get("customSslKey") as string | null)?.trim();
		const clearSsl = formData.get("clearSsl") === "on";
		const saved = await ServiceSettingsService.save(
			svc,
			clearSsl
				? { customSslCert: null, customSslKey: null }
				: { customSslCert: cert || undefined, customSslKey: key || undefined },
			{
				hostAccess: can(locals.permissions, "system", "write"),
				userId: locals.user.id,
			},
		);
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { error: saved.message });
		}

		logger.info(
			`Custom certificate ${clearSsl ? "removed" : "updated"}: service=${svc.id} user=${locals.user.id}`,
		);
		return { success: true };
	},

	// Container port, protocol, network mode, and DNS-resolvability : moved
	// here from the old Settings tab (see validation/service.ts's
	// updatePortsSchema docstring).
	updatePorts: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const formData = await request.formData();
		const result = updatePortsSchema.safeParse(Object.fromEntries(formData));
		if (!result.success) {
			return fail(400, {
				errors: result.error.flatten().fieldErrors,
				portsValues: Object.fromEntries(formData),
			});
		}
		const input = result.data;
		const saved = await ServiceSettingsService.save(svc, input, {
			hostAccess: can(locals.permissions, "system", "write"),
			userId: locals.user.id,
		});
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { error: saved.message });
		}

		logger.info(
			`Ports updated: service=${svc.id} port=${input.containerPort}/${input.portProtocol} networkMode=${input.networkMode} user=${locals.user.id}`,
		);
		return { portsSuccess: true };
	},

	updatePublishedPorts: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const svc = await ServiceDTO.get(params.serviceId);
		if (!svc) {
			return fail(404, { error: "Service not found." });
		}

		const parsed = parsePublishedPortsField(
			(await request.formData()).get("publishedPorts"),
		);
		if ("error" in parsed) {
			return fail(400, { error: parsed.error });
		}
		const { ports } = parsed;
		const saved = await ServiceSettingsService.save(
			svc,
			{ publishedPorts: ports },
			{
				hostAccess: can(locals.permissions, "system", "write"),
				userId: locals.user.id,
			},
		);
		if (saved instanceof ServiceSettingsError) {
			return fail(saved.status, { error: saved.message });
		}
		logger.info(
			`Published ports updated: service=${svc.id} ports=${ports.map((p) => `${p.hostPort}:${p.containerPort}/${p.protocol}`).join(",") || "none"} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
