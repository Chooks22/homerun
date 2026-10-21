import { serviceDomain } from "#lib/config.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import { domainHosts, serviceHostnames } from "#lib/service-domains.js";

/** The service, deployed or not, that routes `host`, or null when none does. */
export async function serviceForHost(host: string): Promise<ServiceDTO | null> {
	const [services, stacks] = await Promise.all([
		ServiceDTO.list(),
		StackDTO.list(),
	]);
	const stackSlugs = new Map(stacks.map((stack) => [stack.id, stack.slug]));
	return (
		services.find((entry) => {
			const row = entry.toJSON();
			return domainHosts(
				serviceHostnames(
					row,
					row.stackId ? stackSlugs.get(row.stackId) : null,
					serviceDomain(),
				),
			).includes(host);
		}) ?? null
	);
}
