import { describe, expect, test } from "bun:test";
import {
	dnsRecordApiJson,
	remoteHostApiJson,
	workstationApiJson,
	workstationPresetApiJson,
} from "#lib/server/infrastructure-api-json.js";

describe("infrastructure REST shapes", () => {
	test("a remote host says which secrets are set instead of carrying them", () => {
		const json = remoteHostApiJson({
			agentTokenEnc: "enc",
			id: "h1",
			name: "box",
			sshHost: "box.example.com",
			sshHostKey: "key",
			sshPort: 22,
			sshUser: "root",
			tlsCaEnc: null,
			tlsCertEnc: "cert",
			tlsKeyEnc: null,
		} as never);
		expect(json).toEqual({
			agentTokenSet: true,
			id: "h1",
			name: "box",
			tlsCaSet: false,
			tlsCertSet: true,
			tlsKeySet: false,
		} as never);
	});

	test("a DNS record is addressed by its domain and the provider's id", () => {
		expect(
			dnsRecordApiJson("d1", {
				content: "203.0.113.4",
				id: "r1",
				managed: true,
				name: "app.example.com",
				priority: null,
				ttl: 300,
				type: "A",
			} as never),
		).toMatchObject({ domainId: "d1", id: "d1/r1", recordId: "r1" });
	});

	test("a workstation and a preset answer their CPU limit as a string", () => {
		expect(workstationApiJson({ cpuLimit: 1.5, id: "ws1" } as never)).toEqual({
			cpuLimit: "1.5",
			id: "ws1",
		} as never);
		expect(
			workstationPresetApiJson({
				authRequired: true,
				cpuLimit: null,
				id: "p1",
			} as never),
		).toEqual({ authRequired: true, cpuLimit: null, id: "p1" } as never);
	});
});
