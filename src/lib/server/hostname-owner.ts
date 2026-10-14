import { config, serviceDomain } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { StatusPageDTO } from "#lib/dto/status-page-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { splitSource } from "#lib/redirects.js";
import {
	domainHosts,
	serviceHostnames,
	splitDomain,
} from "#lib/service-domains.js";
import { workstationHostname } from "#lib/workstations.js";

/**
 * Who already routes a hostname: Homerun itself (the dashboard, a core
 * service's public host, a status page), a workstation, a redirect, or a
 * service. Only a service or a redirect can be taken over by a service.
 */
export type DomainOwner =
	| { kind: "core" | "workstation"; label: string }
	| { id: string; kind: "redirect" | "service"; label: string };

/** A domain entry a service asked for, and who already routes it. */
export interface DomainConflict {
	entry: string;
	owner: DomainOwner;
}

interface RoutedService {
	dnsResolvable: boolean;
	entries: string[];
	id: string;
	name: string;
}

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
 * Homerun's own hosts, each with what answers on it: the dashboard, the
 * registry's and object storage's public hosts and every status page
 * domain. No service, workstation or redirect may take one, and no DNS
 * cleanup may delete one.
 */
export async function coreHosts(): Promise<Map<string, string>> {
	const [settings, pages] = await Promise.all([
		InstanceSettingsDTO.get(),
		StatusPageDTO.list(),
	]);
	const row = settings.toJSON();
	const hosts = new Map<string, string>();
	for (const page of pages) {
		for (const domain of page.domains) {
			hosts.set(domain.toLowerCase(), `the status page "${page.name}"`);
		}
	}
	if (row.garagePublicHost) {
		hosts.set(row.garagePublicHost.toLowerCase(), "object storage");
	}
	if (row.registryPublicHost) {
		hosts.set(row.registryPublicHost.toLowerCase(), "the Docker registry");
	}
	const dashboard = hostOfUrl(config.auth.origin);
	if (dashboard) {
		hosts.set(dashboard, "the Homerun dashboard");
	}
	return hosts;
}

/** Every service with each domain entry it routes, lowercased: its default hostname while kept, then its own domains. */
async function routedServices(): Promise<RoutedService[]> {
	const [services, stacks] = await Promise.all([
		ServiceDTO.list(),
		StackDTO.list(),
	]);
	const stackSlugs = new Map(stacks.map((s) => [s.id, s.toJSON().slug]));
	return services.map((svc) => {
		const row = svc.toJSON();
		return {
			dnsResolvable: svc.dnsResolvable,
			entries: serviceHostnames(
				row,
				row.stackId ? stackSlugs.get(row.stackId) : null,
				serviceDomain(),
			).map((entry) => entry.toLowerCase()),
			id: svc.id,
			name: svc.name,
		};
	});
}

/**
 * What Homerun already routes at `hostname`: the dashboard, the registry or
 * object storage's public host, a status page, a service (its default
 * hostname or one of its domains), a redirect or another workstation than
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
	const [core, services, redirects, workstations] = await Promise.all([
		coreHosts(),
		routedServices(),
		RedirectDTO.list(),
		WorkstationDTO.listAll(),
	]);
	const coreOwner = core.get(host);
	if (coreOwner) {
		return coreOwner;
	}
	const service = services.find((svc) =>
		domainHosts(svc.entries).includes(host),
	);
	if (service) {
		return `the service "${service.name}"`;
	}
	if (redirects.some((r) => splitSource(r.toJSON().source)?.host === host)) {
		return "a redirect";
	}
	const workstation = workstations.find(
		(ws) =>
			ws.id !== exceptWorkstationId &&
			workstationHostname(ws.toJSON(), config.baseDomain) === host,
	);
	return workstation ? "another workstation" : null;
}

/**
 * What already routes each of `entries` (a domain, optionally with a path)
 * besides the service `exceptServiceId`: one of Homerun's own hosts, a
 * workstation or an enabled redirect on the same host, or another service on
 * the very same entry, so `example.com/api` can sit beside another
 * service's `example.com`.
 *
 * @returns One conflict per taken entry, in `entries`' order.
 */
export async function serviceDomainConflicts(
	entries: string[],
	exceptServiceId?: string,
): Promise<DomainConflict[]> {
	if (entries.length === 0) {
		return [];
	}
	const [core, services, redirects, workstations] = await Promise.all([
		coreHosts(),
		routedServices(),
		RedirectDTO.list(),
		WorkstationDTO.listAll(),
	]);
	const workstationHosts = new Set(
		workstations.map((ws) =>
			workstationHostname(ws.toJSON(), config.baseDomain).toLowerCase(),
		),
	);
	const ownerOf = (entry: string): DomainOwner | null => {
		const host = splitDomain(entry).host;
		const coreOwner = core.get(host);
		if (coreOwner) {
			return { kind: "core", label: coreOwner };
		}
		if (workstationHosts.has(host)) {
			return { kind: "workstation", label: "a workstation" };
		}
		const redirect = redirects.find((r) => {
			const row = r.toJSON();
			return row.enabled && splitSource(row.source)?.host === host;
		});
		if (redirect) {
			return {
				id: redirect.toJSON().id,
				kind: "redirect",
				label: `the redirect from ${redirect.toJSON().source}`,
			};
		}
		const service = services.find(
			(svc) => svc.id !== exceptServiceId && svc.entries.includes(entry),
		);
		return service
			? {
					id: service.id,
					kind: "service",
					label: `the service "${service.name}"`,
				}
			: null;
	};
	return entries.flatMap((raw) => {
		const entry = raw.toLowerCase();
		const owner = ownerOf(entry);
		return owner ? [{ entry, owner }] : [];
	});
}

/**
 * Every host a publicly routed service other than `exceptServiceId` still
 * routes, by its default hostname or a custom domain with or without a path.
 * What a service's DNS cleanup must leave alone: `example.com/api` going away
 * doesn't free `example.com` while another service serves it.
 */
export async function serviceRoutedHosts(
	exceptServiceId?: string,
): Promise<Set<string>> {
	const services = await routedServices();
	return new Set(
		services
			.filter((svc) => svc.id !== exceptServiceId && svc.dnsResolvable)
			.flatMap((svc) => domainHosts(svc.entries)),
	);
}
