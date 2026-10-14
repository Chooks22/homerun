import { DomainDTO } from "#lib/dto/domain-dto.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";
import type { Inventory, LiveObject } from "#lib/iac/generate.js";
import { Logger } from "#lib/logger.js";
import {
	dnsRecordApiJson,
	remoteHostApiJson,
	workstationApiJson,
	workstationPresetApiJson,
} from "#lib/server/infrastructure-api-json.js";
import { DomainDnsService } from "#lib/services/domain-dns.service.js";

const logger = new Logger("IaC");

/** The records made by hand in every domain linked to a zone; Homerun's own and a zone that can't be listed are left out. */
async function handMadeRecords(domains: DomainDTO[]): Promise<LiveObject[]> {
	const listed = await Promise.all(
		domains
			.filter((domain) => domain.connectionId)
			.map(async (domain) => {
				try {
					return (await DomainDnsService.records(domain))
						.filter((record) => !record.managed)
						.map((record) => dnsRecordApiJson(domain.id, record));
				} catch (error) {
					logger.warn(
						`DNS records of ${domain.name} left out of the IaC inventory`,
						error,
					);
					return [];
				}
			}),
	);
	return listed.flat();
}

/**
 * The remote hosts, domains, hand-made DNS records, and `userId`'s own
 * workstations and presets, in the shape the REST API returns them, for the
 * IaC page's inventory.
 */
export async function infrastructureInventory(
	userId: string,
): Promise<Inventory> {
	const [hosts, domains, workstations, presets] = await Promise.all([
		RemoteHostDTO.list(),
		DomainDTO.list(),
		WorkstationDTO.listForUser(userId),
		WorkstationPresetDTO.listForUser(userId),
	]);
	return {
		homerun_dns_record: await handMadeRecords(domains),
		homerun_domain: domains.map((domain) => ({ ...domain.toJSON() })),
		homerun_remote_host: hosts.map((host) => remoteHostApiJson(host.toJSON())),
		homerun_workstation: workstations.map((workstation) =>
			workstationApiJson(workstation.toPublic()),
		),
		homerun_workstation_preset: presets.map((preset) =>
			workstationPresetApiJson(preset.toJSON()),
		),
	};
}
