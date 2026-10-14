import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { RemoteHostSettingsError, RemoteHostSettingsService } = await import(
	"../../../src/lib/services/remote-host-settings.service"
);
const { WorkstationService } = await import(
	"../../../src/lib/services/workstation.service"
);
const { AgentClientService } = await import(
	"../../../src/lib/services/agent-client.service"
);
const { decryptSecret } = await import("../../../src/lib/services/secrets");
const { Logger } = await import("../../../src/lib/logger");
const { RemoteHostDTO } = await import("../../../src/lib/dto/remote-host-dto");

type Host = NonNullable<Awaited<ReturnType<typeof RemoteHostDTO.get>>>;

const verified: [string, string][] = [];
let refusal: unknown = null;
const created: Record<string, unknown>[] = [];

function fakeHost(overrides: Record<string, unknown> = {}) {
	const row: Record<string, unknown> = {
		agentToken: null,
		agentUrl: null,
		dockerHost: "tcp://10.0.0.5:2376",
		id: "h1",
		kind: "docker",
		name: "Builder",
		...overrides,
	};
	const updates: Record<string, unknown>[] = [];
	const host = {
		get agentUrl() {
			return row.agentUrl;
		},
		get dockerHost() {
			return row.dockerHost;
		},
		id: row.id,
		get kind() {
			return row.kind;
		},
		get name() {
			return row.name;
		},
		toAgentConnection: () =>
			row.kind === "agent" && row.agentUrl && row.agentToken
				? { agentUrl: row.agentUrl, token: row.agentToken }
				: null,
		update: async (patch: Record<string, unknown>) => {
			updates.push(patch);
			Object.assign(row, patch);
		},
	};
	return { host: host as unknown as Host, updates };
}

beforeEach(() => {
	verified.length = 0;
	created.length = 0;
	refusal = null;
	stub(
		AgentClientService,
		"verifyToken",
		async (agentUrl: string, token: string) => {
			verified.push([agentUrl, token]);
			if (refusal) {
				throw refusal;
			}
		},
	);
	stub(RemoteHostDTO, "create", async (input: Record<string, unknown>) => {
		created.push(input);
		return { id: "h-new", ...input };
	});
	stub(Logger.prototype, "info", () => undefined);
});

afterEach(() => {
	restoreStubs();
});

describe("RemoteHostSettingsService.create", () => {
	test("registers a Docker host with its TLS material encrypted, blanks left out", async () => {
		const host = await RemoteHostSettingsService.create(
			{
				dockerHost: " tcp://10.0.0.5:2376 ",
				name: " Builder ",
				tlsCa: "CA",
				tlsCert: " ",
				tlsKey: "KEY",
			},
			"u1",
		);
		expect(host.id).toBe("h-new");
		const [input] = created;
		expect(input).toMatchObject({
			dockerHost: "tcp://10.0.0.5:2376",
			kind: "docker",
			name: "Builder",
			userId: "u1",
		});
		expect(decryptSecret(input.tlsCaEnc as string)).toBe("CA");
		expect(decryptSecret(input.tlsKeyEnc as string)).toBe("KEY");
		expect(input).not.toHaveProperty("tlsCertEnc");
	});

	test("refuses a missing name and a Docker host that isn't tcp:// or ssh://", async () => {
		await expect(
			RemoteHostSettingsService.create({ dockerHost: "tcp://h:1" }, "u1"),
		).rejects.toThrow("Name is required.");
		await expect(
			RemoteHostSettingsService.create(
				{ dockerHost: "not a url", name: "B" },
				"u1",
			),
		).rejects.toThrow("Docker host must be a URL");
		await expect(
			RemoteHostSettingsService.create(
				{ dockerHost: "http://h:2375", name: "B" },
				"u1",
			),
		).rejects.toBeInstanceOf(RemoteHostSettingsError);
		await expect(
			RemoteHostSettingsService.create(
				{ dockerHost: "ssh://h", name: "B" },
				"u1",
			),
		).rejects.toThrow("An ssh:// Docker host needs a user");
		expect(created).toEqual([]);
	});

	test("verifies an agent's token before saving it encrypted", async () => {
		await RemoteHostSettingsService.create(
			{
				agentToken: " tok ",
				agentUrl: "http://10.0.0.5:7420",
				kind: "agent",
				name: "Agent",
			},
			"u1",
		);
		expect(verified).toEqual([["http://10.0.0.5:7420", "tok"]]);
		expect(created[0]).toMatchObject({
			agentUrl: "http://10.0.0.5:7420",
			kind: "agent",
		});
		expect(decryptSecret(created[0].agentTokenEnc as string)).toBe("tok");
	});

	test("an agent needs a full URL and a token the agent accepts", async () => {
		await expect(
			RemoteHostSettingsService.create(
				{ agentUrl: "http://a", kind: "agent", name: "A" },
				"u1",
			),
		).rejects.toThrow("Agent URL and token are required.");
		await expect(
			RemoteHostSettingsService.create(
				{ agentToken: "t", agentUrl: "10.0.0.5", kind: "agent", name: "A" },
				"u1",
			),
		).rejects.toThrow("Agent URL must be a full URL");
		refusal = new Error("The agent refused the token.");
		await expect(
			RemoteHostSettingsService.create(
				{
					agentToken: "t",
					agentUrl: "http://a:7420",
					kind: "agent",
					name: "A",
				},
				"u1",
			),
		).rejects.toThrow("The agent refused the token.");
		refusal = "boom";
		await expect(
			RemoteHostSettingsService.create(
				{
					agentToken: "t",
					agentUrl: "http://a:7420",
					kind: "agent",
					name: "A",
				},
				"u1",
			),
		).rejects.toThrow("Couldn't verify the agent.");
		expect(created).toEqual([]);
	});
});

describe("RemoteHostSettingsService.update", () => {
	test("a Docker host keeps the fields left out and the stored TLS", async () => {
		const { host, updates } = fakeHost();
		await RemoteHostSettingsService.update(host, { tlsCert: "CERT" });
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			dockerHost: "tcp://10.0.0.5:2376",
			name: "Builder",
		});
		expect(decryptSecret(updates[0].tlsCertEnc as string)).toBe("CERT");
		expect(updates[0]).not.toHaveProperty("tlsCaEnc");
	});

	test("moving to another ssh:// address forgets the recorded host key, other edits keep it", async () => {
		const { host, updates } = fakeHost({ dockerHost: "ssh://deploy@a" });
		await RemoteHostSettingsService.update(host, { name: "Renamed" });
		expect(updates[0]).not.toHaveProperty("sshHostKey");
		await RemoteHostSettingsService.update(host, {
			dockerHost: "ssh://deploy@b",
		});
		expect(updates[1]).toMatchObject({
			dockerHost: "ssh://deploy@b",
			sshHostKey: null,
		});
		await RemoteHostSettingsService.update(host, {
			dockerHost: "tcp://b:2376",
		});
		expect(updates[2]).not.toHaveProperty("sshHostKey");
	});

	test("refuses a blank name or a bad Docker host", async () => {
		const { host, updates } = fakeHost();
		await expect(
			RemoteHostSettingsService.update(host, { name: "  " }),
		).rejects.toThrow("Name is required.");
		await expect(
			RemoteHostSettingsService.update(host, { dockerHost: "unix:///var/run" }),
		).rejects.toThrow("Only tcp:// and ssh:// hosts are supported.");
		expect(updates).toEqual([]);
	});

	test("an agent with the same URL and no new token isn't verified again", async () => {
		const { host, updates } = fakeHost({
			agentToken: "stored",
			agentUrl: "http://a:7420",
			kind: "agent",
		});
		await RemoteHostSettingsService.update(host, { name: "Renamed" });
		expect(verified).toEqual([]);
		expect(updates).toEqual([{ agentUrl: "http://a:7420", name: "Renamed" }]);
	});

	test("a new agent URL is verified with the stored token", async () => {
		const { host, updates } = fakeHost({
			agentToken: "stored",
			agentUrl: "http://a:7420",
			kind: "agent",
		});
		await RemoteHostSettingsService.update(host, { agentUrl: "http://b:7420" });
		expect(verified).toEqual([["http://b:7420", "stored"]]);
		expect(updates[0]).toEqual({ agentUrl: "http://b:7420", name: "Builder" });
	});

	test("a new token is verified and stored encrypted", async () => {
		const { host, updates } = fakeHost({
			agentToken: "stored",
			agentUrl: "http://a:7420",
			kind: "agent",
		});
		await RemoteHostSettingsService.update(host, { agentToken: "fresh" });
		expect(verified).toEqual([["http://a:7420", "fresh"]]);
		expect(decryptSecret(updates[0].agentTokenEnc as string)).toBe("fresh");
	});

	test("an agent with no token to verify a new URL with is refused", async () => {
		const { host, updates } = fakeHost({
			agentToken: null,
			agentUrl: null,
			kind: "agent",
		});
		await expect(
			RemoteHostSettingsService.update(host, { agentUrl: "http://b:7420" }),
		).rejects.toThrow("Agent token is required.");
		await expect(RemoteHostSettingsService.update(host, {})).rejects.toThrow(
			"Agent URL is required.",
		);
		expect(updates).toEqual([]);
	});
});

describe("RemoteHostSettingsService.remove", () => {
	test("cleans up the host's workstations before the row goes", async () => {
		const order: string[] = [];
		const cleanup = spyOn(
			WorkstationService,
			"removeAllOnHost",
		).mockImplementation(async (hostId: string) => {
			order.push(`workstations:${hostId}`);
		});
		const host = {
			delete: mock(async () => {
				order.push("row");
			}),
			id: "h1",
		} as unknown as Host;
		await RemoteHostSettingsService.remove(host);
		expect(order).toEqual(["workstations:h1", "row"]);
		cleanup.mockRestore();
	});
});
