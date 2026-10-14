import type {
	RemoteHost,
	Workstation,
	WorkstationPreset,
} from "#lib/server/db/schema.js";
import type { DnsRecord } from "#lib/services/dns-providers/types.js";

/** A CPU limit as the REST API answers it: a string, like a service's. */
function cpuLimitText(cpuLimit: number | null): string | null {
	return cpuLimit === null ? null : String(cpuLimit);
}

/**
 * A remote host as the REST API returns it: without its ciphertext columns
 * (whether each secret is set instead) and without the terminal's SSH
 * settings, which belong to the Terminal page.
 */
export function remoteHostApiJson(row: RemoteHost) {
	const {
		agentTokenEnc,
		sshHost: _sshHost,
		sshHostKey: _sshHostKey,
		sshPort: _sshPort,
		sshUser: _sshUser,
		tlsCaEnc,
		tlsCertEnc,
		tlsKeyEnc,
		...rest
	} = row;
	return {
		...rest,
		agentTokenSet: Boolean(agentTokenEnc),
		tlsCaSet: Boolean(tlsCaEnc),
		tlsCertSet: Boolean(tlsCertEnc),
		tlsKeySet: Boolean(tlsKeyEnc),
	};
}

/** One record of a domain's zone, addressed by the domain and the provider's record id (`<domainId>/<recordId>` is its id). */
export function dnsRecordApiJson(
	domainId: string,
	record: DnsRecord & { managed: boolean },
) {
	return {
		content: record.content,
		domainId,
		id: `${domainId}/${record.id}`,
		managed: record.managed,
		name: record.name,
		priority: record.priority,
		recordId: record.id,
		ttl: record.ttl,
		type: record.type,
	};
}

/** A workstation without its IDE password, its CPU limit as a string. */
export function workstationApiJson(row: Omit<Workstation, "passwordEnc">) {
	return { ...row, cpuLimit: cpuLimitText(row.cpuLimit) };
}

/** A workstation preset, its CPU limit as a string. */
export function workstationPresetApiJson(row: WorkstationPreset) {
	return { ...row, cpuLimit: cpuLimitText(row.cpuLimit) };
}
