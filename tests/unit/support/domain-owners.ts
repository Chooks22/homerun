import { stub } from "./stub";

export interface DomainOwners {
	redirects: string[];
	services: { domains: string[]; id: string }[];
	workstations: string[];
}

/**
 * Stubs every list `serviceDomainConflicts` and `hostnameOwner` read, with no
 * core host besides what the test's config gives, and returns the owners they
 * see, for a test to fill: `services` route only their `domains` (default
 * hostname off), `redirects` are enabled sources, `workstations` their hosts.
 * Imported lazily so a test's `mock.module` calls run first.
 */
export async function stubDomainOwners(): Promise<DomainOwners> {
	const [
		{ InstanceSettingsDTO },
		{ RedirectDTO },
		{ ServiceDTO },
		{ StackDTO },
		{ StatusPageDTO },
		{ WorkstationDTO },
	] = await Promise.all([
		import("../../../src/lib/dto/instance-settings-dto"),
		import("../../../src/lib/dto/redirect-dto"),
		import("../../../src/lib/dto/service-dto"),
		import("../../../src/lib/dto/stack-dto"),
		import("../../../src/lib/dto/status-page-dto"),
		import("../../../src/lib/dto/workstation-dto"),
	]);
	const owners: DomainOwners = {
		redirects: [],
		services: [],
		workstations: [],
	};
	stub(InstanceSettingsDTO, "get", async () => ({ toJSON: () => ({}) }));
	stub(StatusPageDTO, "list", async () => []);
	stub(StackDTO, "list", async () => []);
	stub(ServiceDTO, "list", async () =>
		owners.services.map((svc) => ({
			dnsResolvable: true,
			id: svc.id,
			name: svc.id,
			toJSON: () => ({
				defaultDomainEnabled: false,
				domains: svc.domains,
				slug: svc.id,
				stackId: null,
			}),
		})),
	);
	stub(RedirectDTO, "list", async () =>
		owners.redirects.map((source, index) => ({
			toJSON: () => ({ enabled: true, id: `r${index}`, source }),
		})),
	);
	stub(WorkstationDTO, "listAll", async () =>
		owners.workstations.map((domain, index) => ({
			id: `w${index}`,
			toJSON: () => ({ domain, slug: `w${index}` }),
		})),
	);
	return owners;
}
