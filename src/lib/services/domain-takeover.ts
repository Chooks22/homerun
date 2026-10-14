import { serviceDomain } from "#lib/config.js";
import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import type { ServiceUpdateInput } from "#lib/dto/service-input.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { Logger } from "#lib/logger.js";
import type { DomainConflict } from "#lib/server/hostname-owner.js";
import { defaultHostname, serviceHostnames } from "#lib/service-domains.js";
import { RedirectService } from "./redirect.service.ts";

const logger = new Logger("Services");

/** The routing columns of a service once `entries` are taken from it, public routing turned off when nothing is left. */
async function withoutEntries(
	owner: ServiceDTO,
	entries: Set<string>,
): Promise<ServiceUpdateInput> {
	const row = owner.toJSON();
	const stackSlug = row.stackId
		? ((await StackDTO.get(row.stackId))?.slug ?? null)
		: null;
	const domains = row.domains.filter((domain) => !entries.has(domain));
	const defaultDomainEnabled =
		row.defaultDomainEnabled &&
		!entries.has(defaultHostname(row.slug, stackSlug, serviceDomain()));
	const remaining = serviceHostnames(
		{ ...row, defaultDomainEnabled, domains },
		stackSlug,
		serviceDomain(),
	);
	return {
		defaultDomainEnabled,
		domainPorts: Object.fromEntries(
			Object.entries(row.domainPorts).filter(
				([domain]) => !entries.has(domain),
			),
		),
		domains,
		primaryDomain:
			row.primaryDomain && entries.has(row.primaryDomain)
				? null
				: row.primaryDomain,
		stripPathDomains: row.stripPathDomains.filter(
			(domain) => !entries.has(domain),
		),
		...(remaining.length === 0 ? { dnsResolvable: false } : {}),
	};
}

/**
 * Takes each conflicting domain entry away from its owner so the service
 * `serviceId` can have it: a service loses the entry (its default hostname
 * is turned off when that's the one, and public routing when nothing is
 * left), a redirect is disabled and the redirects file rewritten. Neither
 * owner's DNS record is deleted, since the host stays routed. A service
 * owner keeps serving the host until its next deploy, so traffic never has
 * nowhere to go while the taker deploys.
 *
 * @returns What each entry was taken from, to tell the user.
 * @throws When an owner is Homerun itself or a workstation, neither of which can give a hostname up.
 */
export async function takeOverDomains(
	conflicts: DomainConflict[],
	serviceId: string,
	userId: string,
): Promise<string[]> {
	const byOwner = new Map<string, Set<string>>();
	for (const { entry, owner } of conflicts) {
		if (owner.kind !== "service" && owner.kind !== "redirect") {
			throw new Error(
				`${entry} belongs to ${owner.label} and can't be taken over.`,
			);
		}
		const key = `${owner.kind}:${owner.id}`;
		byOwner.set(key, (byOwner.get(key) ?? new Set()).add(entry));
	}
	let redirectsChanged = false;
	await Promise.all(
		[...byOwner].map(async ([key, entries]) => {
			const [kind, id] = key.split(":") as [string, string];
			if (kind === "redirect") {
				const redirect = await RedirectDTO.get(id);
				await redirect?.setEnabled(false);
				redirectsChanged = true;
				return;
			}
			const owner = await ServiceDTO.get(id);
			if (owner) {
				await owner.update(await withoutEntries(owner, entries));
			}
		}),
	);
	if (redirectsChanged) {
		await RedirectService.sync();
	}
	const labels = [
		...new Set(conflicts.map((conflict) => conflict.owner.label)),
	];
	logger.info(
		`Domains taken over: service=${serviceId} entries=${conflicts.map((conflict) => conflict.entry).join(",")} from=${labels.join(";")} user=${userId}`,
	);
	return labels;
}
