import { DnsConnectionDTO } from "#lib/dto/dns-connection-dto.js";
import { DomainDTO, type DomainInput } from "#lib/dto/domain-dto.js";
import { Logger } from "#lib/logger.js";
import { normalizeName } from "#lib/services/dns-providers/http.js";

const logger = new Logger("DNS");

/** A domain change refused for the caller's input; nothing was saved. */
export class DomainSettingsError extends Error {}

type DomainLink = Pick<DomainInput, "connectionId" | "zoneId" | "zoneName">;

/**
 * Adding and editing the domains the instance manages, shared by the DNS
 * page and the REST API.
 */
class DomainSettingsServiceClass {
	/**
	 * Adds a domain owned by `userId`.
	 *
	 * @throws {DomainSettingsError} When a domain with that name is already
	 *   added, or its connection or zone doesn't exist.
	 */
	async add(input: DomainInput, userId: string): Promise<DomainDTO> {
		const name = normalizeName(input.name);
		if ((await DomainDTO.list()).some((domain) => domain.name === name)) {
			throw new DomainSettingsError(`${name} is already added.`);
		}
		const domain = await DomainDTO.create({
			...input,
			...(await this.#link(input)),
			name,
			userId,
		});
		logger.info(
			`Domain added: ${domain.name} connection=${input.connectionId ?? "none"} user=${userId}`,
		);
		return domain;
	}

	/**
	 * Saves the fields sent and keeps the rest; the name never changes.
	 *
	 * @throws {DomainSettingsError} When the connection or zone doesn't exist.
	 */
	async update(
		domain: DomainDTO,
		input: Partial<Omit<DomainInput, "name">>,
	): Promise<void> {
		const current = domain.toJSON();
		const linkChanged =
			input.connectionId !== undefined ||
			input.zoneId !== undefined ||
			input.zoneName !== undefined;
		const link = linkChanged
			? await this.#link({
					connectionId:
						input.connectionId === undefined
							? current.connectionId
							: input.connectionId,
					zoneId: input.zoneId === undefined ? current.zoneId : input.zoneId,
					zoneName: input.zoneName ?? null,
				})
			: {};
		await domain.update({
			...(input.autoRecords === undefined
				? {}
				: { autoRecords: input.autoRecords }),
			...(input.target === undefined
				? {}
				: { target: input.target?.trim() || null }),
			...link,
		});
		logger.info(`Domain saved: ${domain.name}`);
	}

	/**
	 * The connection and zone columns: none without a connection, the zone's
	 * name looked up at the provider when it isn't given.
	 *
	 * @throws {DomainSettingsError} When the connection is unknown, the zone
	 *   is missing, or the provider doesn't list it.
	 */
	async #link(input: DomainLink): Promise<DomainLink> {
		if (!input.connectionId) {
			return { connectionId: null, zoneId: null, zoneName: null };
		}
		const connection = await DnsConnectionDTO.get(input.connectionId);
		if (!connection) {
			throw new DomainSettingsError("That DNS connection doesn't exist.");
		}
		if (!input.zoneId) {
			throw new DomainSettingsError("Pick the zone the domain lives in.");
		}
		if (input.zoneName) {
			return input;
		}
		const zones = await connection
			.client()
			.listZones()
			.catch((error: unknown) => {
				throw new DomainSettingsError(
					`Couldn't list the connection's zones: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		const zone = zones.find((candidate) => candidate.id === input.zoneId);
		if (!zone) {
			throw new DomainSettingsError(
				`The connection has no zone ${input.zoneId}.`,
			);
		}
		return { ...input, zoneName: zone.name };
	}
}

export const DomainSettingsService = new DomainSettingsServiceClass();
