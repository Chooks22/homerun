import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { StatusPageDTO } from "#lib/dto/status-page-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { splitSource } from "#lib/redirects.js";
import { serviceHostnames } from "#lib/service-domains.js";
import { workstationHostname } from "#lib/workstations.js";

/** The host part of a URL, null when it isn't one. */
function hostOfUrl(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * What Homerun already routes at `hostname`: the dashboard, the registry or
 * object storage's public host, a service (its default hostname or one of
 * its domains), a redirect, a status page or another workstation than
 * `exceptWorkstationId`. Another account's workstation isn't named.
 *
 * @returns A description of the owner to show the user, or null when the
 *   hostname is free.
 */
export async function hostnameOwner(
	hostname: string,
	exceptWorkstationId?: string,
): Promise<string | null> {
	const host = hostname.trim().toLowerCase();
	const [settings, services, stacks, redirects, page, workstations] =
		await Promise.all([
			InstanceSettingsDTO.get(),
			ServiceDTO.list(),
			StackDTO.list(),
			RedirectDTO.list(),
			StatusPageDTO.domainOwner([host]),
			WorkstationDTO.listAll(),
		]);
	if (hostOfUrl(config.auth.origin) === host) {
		return "the Homerun dashboard";
	}
	const row = settings.toJSON();
	if (row.registryPublicHost?.toLowerCase() === host) {
		return "the Docker registry";
	}
	if (row.garagePublicHost?.toLowerCase() === host) {
		return "object storage";
	}
	const stackSlugs = new Map(stacks.map((s) => [s.id, s.toJSON().slug]));
	const service = services.find((svc) => {
		const svcRow = svc.toJSON();
		return serviceHostnames(
			svcRow,
			svcRow.stackId ? stackSlugs.get(svcRow.stackId) : null,
			config.baseDomain,
		).some((name) => name.toLowerCase() === host);
	});
	if (service) {
		return `the service "${service.name}"`;
	}
	if (redirects.some((r) => splitSource(r.toJSON().source)?.host === host)) {
		return "a redirect";
	}
	if (page) {
		return `the status page "${page.name}"`;
	}
	const workstation = workstations.find(
		(ws) =>
			ws.id !== exceptWorkstationId &&
			workstationHostname(ws.toJSON(), config.baseDomain) === host,
	);
	return workstation ? "another workstation" : null;
}
