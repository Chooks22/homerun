import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { expectOk } from "./support/assert";
import type { ApiClient } from "./support/client";
import { apiClient } from "./support/context";

let client: ApiClient;
const hostIds: string[] = [];
const domainIds: string[] = [];
const workstationIds: string[] = [];
const presetIds: string[] = [];

beforeAll(() => {
	client = apiClient();
});

afterAll(async () => {
	await Promise.all([
		...workstationIds.map((workstationId) =>
			client.DELETE("/workstations/{workstationId}", {
				params: { path: { workstationId } },
			}),
		),
		...presetIds.map((presetId) =>
			client.DELETE("/workstation-presets/{presetId}", {
				params: { path: { presetId } },
			}),
		),
		...domainIds.map((domainId) =>
			client.DELETE("/domains/{domainId}", { params: { path: { domainId } } }),
		),
	]);
	await Promise.all(
		hostIds.map((hostId) =>
			client.DELETE("/remote-hosts/{hostId}", { params: { path: { hostId } } }),
		),
	);
});

describe("remote hosts", () => {
	test("creates, reads, updates, lists and deletes a Docker host without returning its TLS key", async () => {
		const created = await client.POST("/remote-hosts", {
			body: {
				dockerHost: "tcp://127.0.0.1:1",
				kind: "docker",
				name: "infra-api-builder",
				tlsKey: "-----BEGIN PRIVATE KEY-----",
			},
		});
		const host = expectOk(created.data, created.response);
		hostIds.push(host.id);
		expect(created.response.status).toBe(201);
		expect(host.kind).toBe("docker");
		expect(host.tlsKeySet).toBe(true);
		expect(host.tlsCaSet).toBe(false);
		expect(JSON.stringify(host)).not.toContain("PRIVATE KEY");

		const updated = await client.PATCH("/remote-hosts/{hostId}", {
			body: { name: "infra-api-builder-2" },
			params: { path: { hostId: host.id } },
		});
		const after = expectOk(updated.data, updated.response);
		expect(after.name).toBe("infra-api-builder-2");
		expect(after.dockerHost).toBe("tcp://127.0.0.1:1");
		expect(after.tlsKeySet).toBe(true);

		const listed = await client.GET("/remote-hosts", {
			params: { query: { q: "infra-api-builder-2" } },
		});
		expect(
			expectOk(listed.data, listed.response).map((entry) => entry.id),
		).toContain(host.id);

		const deleted = await client.DELETE("/remote-hosts/{hostId}", {
			params: { path: { hostId: host.id } },
		});
		expect(deleted.response.status).toBe(204);
		const gone = await client.GET("/remote-hosts/{hostId}", {
			params: { path: { hostId: host.id } },
		});
		expect(gone.response.status).toBe(404);
	});

	test("refuses a daemon URL that isn't tcp:// or ssh://, and an agent that can't be reached", async () => {
		const badDocker = await client.POST("/remote-hosts", {
			body: { dockerHost: "http://example.com", kind: "docker", name: "bad" },
		});
		expect(badDocker.response.status).toBe(400);
		expect(badDocker.error?.error).toContain("tcp://");

		const missingToken = await client.POST("/remote-hosts", {
			body: { agentUrl: "http://127.0.0.1:1", kind: "agent", name: "bad" },
		});
		expect(missingToken.response.status).toBe(400);

		const unreachable = await client.POST("/remote-hosts", {
			body: {
				agentToken: "token",
				agentUrl: "http://127.0.0.1:1",
				kind: "agent",
				name: "bad",
			},
		});
		expect(unreachable.response.status).toBe(400);
	});
});

describe("domains and DNS records", () => {
	test("adds, edits and removes a domain, refusing a duplicate and a zone without a connection", async () => {
		const created = await client.POST("/domains", {
			body: { autoRecords: false, name: "Infra-API.example.com" },
		});
		const domain = expectOk(created.data, created.response);
		domainIds.push(domain.id);
		expect(created.response.status).toBe(201);
		expect(domain.name).toBe("infra-api.example.com");
		expect(domain.connectionId).toBeNull();

		const duplicate = await client.POST("/domains", {
			body: { autoRecords: true, name: "infra-api.example.com" },
		});
		expect(duplicate.response.status).toBe(400);
		expect(duplicate.error?.error).toContain("already added");

		const badConnection = await client.PATCH("/domains/{domainId}", {
			body: { connectionId: "no-such-connection", zoneId: "zone" },
			params: { path: { domainId: domain.id } },
		});
		expect(badConnection.response.status).toBe(400);

		const updated = await client.PATCH("/domains/{domainId}", {
			body: { autoRecords: true, target: "203.0.113.10" },
			params: { path: { domainId: domain.id } },
		});
		const after = expectOk(updated.data, updated.response);
		expect(after.target).toBe("203.0.113.10");
		expect(after.autoRecords).toBe(true);

		const records = await client.GET("/domains/{domainId}/records", {
			params: { path: { domainId: domain.id } },
		});
		expect(records.response.status).toBe(400);
		expect(records.error?.error).toContain("Link the domain");

		const record = await client.POST("/domains/{domainId}/records", {
			body: { content: "not-an-ip", name: "www", type: "A" },
			params: { path: { domainId: domain.id } },
		});
		expect(record.response.status).toBe(400);
		expect(record.error?.error).toContain("IPv4");

		const deleted = await client.DELETE("/domains/{domainId}", {
			params: { path: { domainId: domain.id } },
		});
		expect(deleted.response.status).toBe(204);
		const missing = await client.GET("/domains/{domainId}/records/{recordId}", {
			params: { path: { domainId: domain.id, recordId: "A/www/1.2.3.4" } },
		});
		expect(missing.response.status).toBe(404);
	});

	test("refuses a name that isn't a domain", async () => {
		const created = await client.POST("/domains", {
			body: { autoRecords: true, name: "not a domain" },
		});
		expect(created.response.status).toBe(400);
	});
});

describe("workstations and presets", () => {
	test("creates a stopped workstation, edits it, and keeps it to its owner's key", async () => {
		const created = await client.POST("/workstations", {
			body: {
				autoStopMinutes: 60,
				autoStopMode: "idle",
				cpuLimit: 1.5,
				desiredState: "stopped",
				env: { FOO: "bar", PASSWORD: "ignored" },
				extensions: ["Esbenp.Prettier-VSCode", "esbenp.prettier-vscode"],
				name: "Infra API IDE",
			},
		});
		const workstation = expectOk(created.data, created.response);
		workstationIds.push(workstation.id);
		expect(created.response.status).toBe(201);
		expect(workstation.desiredState).toBe("stopped");
		expect(workstation.cpuLimit).toBe("1.5");
		expect(workstation.env).toEqual({ FOO: "bar" });
		expect(workstation.extensions).toEqual(["esbenp.prettier-vscode"]);
		expect(workstation.autoStopMode).toBe("idle");
		expect(workstation.autoStopMinutes).toBe(60);
		expect(workstation.image).toBe("codercom/code-server:latest");
		expect(workstation.domain).toContain(workstation.slug);

		const updated = await client.PATCH("/workstations/{workstationId}", {
			body: { autoStopMode: null, cpuLimit: "2", name: "Renamed IDE" },
			params: { path: { workstationId: workstation.id } },
		});
		const after = expectOk(updated.data, updated.response);
		expect(after.name).toBe("Renamed IDE");
		expect(after.cpuLimit).toBe("2");
		expect(after.autoStopMode).toBeNull();
		expect(after.desiredState).toBe("stopped");

		const badAutoStop = await client.PATCH("/workstations/{workstationId}", {
			body: { autoStopMinutes: 1 },
			params: { path: { workstationId: workstation.id } },
		});
		expect(badAutoStop.response.status).toBe(400);

		const listed = await client.GET("/workstations");
		expect(
			expectOk(listed.data, listed.response).map((entry) => entry.id),
		).toContain(workstation.id);

		const deleted = await client.DELETE("/workstations/{workstationId}", {
			params: { path: { workstationId: workstation.id } },
		});
		expect(deleted.response.status).toBe(204);
		const gone = await client.GET("/workstations/{workstationId}", {
			params: { path: { workstationId: workstation.id } },
		});
		expect(gone.response.status).toBe(404);
	});

	test("runs a workstation on tcp:// and ssh:// Docker hosts, and refuses an ssh:// host with no user", async () => {
		for (const [name, dockerHost] of [
			["ws-tcp-host", "tcp://127.0.0.1:1"],
			["ws-ssh-host", "ssh://deploy@127.0.0.1"],
		]) {
			const host = await client.POST("/remote-hosts", {
				body: { dockerHost, kind: "docker", name },
			});
			const hostId = expectOk(host.data, host.response).id;
			hostIds.push(hostId);
			const created = await client.POST("/workstations", {
				body: {
					desiredState: "stopped",
					name: `on ${name}`,
					remoteHostId: hostId,
				},
			});
			workstationIds.push(expectOk(created.data, created.response).id);
			expect(created.response.status).toBe(201);
		}

		const userless = await client.POST("/remote-hosts", {
			body: {
				dockerHost: "ssh://127.0.0.1",
				kind: "docker",
				name: "ws-ssh-no-user",
			},
		});
		expect(userless.response.status).toBe(400);
	});

	test("creates, edits and deletes a preset", async () => {
		const created = await client.POST("/workstation-presets", {
			body: {
				description: "Node",
				extensions: ["esbenp.prettier-vscode"],
				memoryLimitMb: 2048,
				name: "infra-api-node",
			},
		});
		const preset = expectOk(created.data, created.response);
		presetIds.push(preset.id);
		expect(created.response.status).toBe(201);
		expect(preset.port).toBe(8080);
		expect(preset.memoryLimitMb).toBe(2048);

		const updated = await client.PATCH("/workstation-presets/{presetId}", {
			body: { description: null, memoryLimitMb: 4096 },
			params: { path: { presetId: preset.id } },
		});
		const after = expectOk(updated.data, updated.response);
		expect(after.memoryLimitMb).toBe(4096);
		expect(after.description).toBeNull();
		expect(after.extensions).toEqual(["esbenp.prettier-vscode"]);

		const deleted = await client.DELETE("/workstation-presets/{presetId}", {
			params: { path: { presetId: preset.id } },
		});
		expect(deleted.response.status).toBe(204);
	});
});
