import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreStubs, stub } from "../support/stub";
import { stubFetch } from "./dns-providers/stub-fetch";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { NodeEnrollmentService, EnrollError } = await import(
	"../../../src/lib/services/node-enrollment.service"
);
const { NodeEnrollmentDTO } = await import(
	"../../../src/lib/dto/node-enrollment-dto"
);
const { RemoteHostDTO } = await import("../../../src/lib/dto/remote-host-dto");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { AgentClientService } = await import(
	"../../../src/lib/services/agent-client.service"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { enrollCommand, nodeInstallScript, releaseTagFor } = await import(
	"../../../src/lib/server/node-install-script"
);
const { toSwarmNodeInfo } = await import(
	"../../../src/lib/services/docker/swarm"
);

interface Scenario {
	agentOk: boolean;
	buildServer: boolean;
	claimed: boolean;
	mode: "standalone" | "swarm";
	swarmNode: boolean;
	usable: boolean;
}

let scenario: Scenario;
const created: unknown[] = [];
const deleted: string[] = [];

beforeEach(() => {
	scenario = {
		agentOk: true,
		buildServer: true,
		claimed: true,
		mode: "swarm",
		swarmNode: false,
		usable: true,
	};
	created.length = 0;
	deleted.length = 0;
	stub(NodeEnrollmentDTO, "findUsable", async () =>
		scenario.usable
			? {
					claim: async () => scenario.claimed,
					roles: {
						buildServer: scenario.buildServer,
						swarmNode: scenario.swarmNode,
					},
					toJSON: () => ({ name: null, userId: "u1" }),
				}
			: null,
	);
	stub(InstanceSettingsDTO, "get", async () => ({
		orchestrationMode: scenario.mode,
	}));
	stub(DockerService, "swarmJoinInfo", async () => ({
		managerAddress: "10.0.0.1:2377",
		token: "SWMTKN-1",
	}));
	stub(AgentClientService, "verifyToken", async () => {
		if (!scenario.agentOk) {
			throw new Error("Couldn't reach the agent.");
		}
	});
	stub(RemoteHostDTO, "create", async (input: unknown) => {
		created.push(input);
		return {
			delete: async () => {
				deleted.push("h1");
			},
			id: "h1",
		};
	});
});

afterEach(() => restoreStubs());

const request = {
	agentToken: "agent-token",
	agentUrl: "http://10.0.0.5:7420",
	hostname: "box",
	token: "hrn_x",
};

/** The status an enrollment is refused with. */
async function refusal(run: () => Promise<unknown>): Promise<number> {
	try {
		await run();
	} catch (error) {
		if (error instanceof EnrollError) {
			return error.status;
		}
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("NodeEnrollmentService", () => {
	test("a build server is registered as an agent host named after the server", async () => {
		expect(await NodeEnrollmentService.enroll(request)).toEqual({
			remoteHostId: "h1",
			swarm: null,
		});
		expect(created).toEqual([
			expect.objectContaining({
				agentUrl: "http://10.0.0.5:7420",
				kind: "agent",
				name: "box",
				userId: "u1",
			}),
		]);
	});

	test("a swarm node gets the join token and no host", async () => {
		scenario.buildServer = false;
		scenario.swarmNode = true;
		expect(
			await NodeEnrollmentService.enroll({ hostname: "box", token: "t" }),
		).toEqual({
			remoteHostId: null,
			swarm: { managerAddress: "10.0.0.1:2377", token: "SWMTKN-1" },
		});
		expect(await NodeEnrollmentService.plan("t")).toEqual({
			buildServer: false,
			swarmNode: true,
		});
	});

	test("refuses an unusable token, missing or unreachable agents and swarm nodes without swarm mode", async () => {
		scenario.usable = false;
		expect(await refusal(() => NodeEnrollmentService.enroll(request))).toBe(
			401,
		);
		scenario.usable = true;
		expect(
			await refusal(() =>
				NodeEnrollmentService.enroll({ hostname: "box", token: "t" }),
			),
		).toBe(400);
		expect(
			await refusal(() =>
				NodeEnrollmentService.enroll({ ...request, agentUrl: "nope" }),
			),
		).toBe(400);
		scenario.agentOk = false;
		expect(await refusal(() => NodeEnrollmentService.enroll(request))).toBe(
			502,
		);
		scenario.swarmNode = true;
		scenario.mode = "standalone";
		expect(await refusal(() => NodeEnrollmentService.plan("t"))).toBe(409);
		expect(created).toEqual([]);
	});

	test("losing the race to claim the token deletes the host it made", async () => {
		scenario.claimed = false;
		expect(await refusal(() => NodeEnrollmentService.enroll(request))).toBe(
			409,
		);
		expect(deleted).toEqual(["h1"]);
	});
});

describe("node install script", () => {
	test("pins the instance's release, and the command pipes the script with the token", () => {
		expect(releaseTagFor("1.0.49")).toBe("v1.0.49");
		expect(releaseTagFor("dev")).toBe("latest");
		expect(enrollCommand("https://h.example.com", "hrn_a")).toBe(
			"curl -fsSL https://h.example.com/api/v1/nodes/install.sh | sudo bash -s -- --token=hrn_a",
		);
	});

	test("is valid bash that talks to this instance", async () => {
		const script = nodeInstallScript("https://h.example.com", "1.0.49");
		expect(script).toContain('HOMERUN_URL="https://h.example.com"');
		expect(script).toContain('VERSION="v1.0.49"');
		const path = join(mkdtempSync(join(tmpdir(), "enroll-")), "install.sh");
		writeFileSync(path, script);
		const check = Bun.spawnSync(["bash", "-n", path]);
		expect(check.stderr.toString()).toBe("");
		expect(check.exitCode).toBe(0);
	});
});

describe("toSwarmNodeInfo", () => {
	test("flattens a node inspect", () => {
		expect(
			toSwarmNodeInfo({
				Description: {
					Engine: { EngineVersion: "27.0" },
					Hostname: "box",
					Platform: { Architecture: "x86_64", OS: "linux" },
					Resources: { MemoryBytes: 2 * 1024 ** 3, NanoCPUs: 4e9 },
				},
				ID: "n1",
				ManagerStatus: { Leader: true },
				Spec: {
					Availability: "active",
					Labels: { env: "prod" },
					Role: "manager",
				},
				Status: { Addr: "10.0.0.1", State: "ready" },
			}),
		).toEqual({
			address: "10.0.0.1",
			architecture: "x86_64",
			availability: "active",
			cpus: 4,
			engineVersion: "27.0",
			hostname: "box",
			id: "n1",
			labels: { env: "prod" },
			leader: true,
			memoryBytes: 2 * 1024 ** 3,
			role: "manager",
			state: "ready",
		});
		expect(toSwarmNodeInfo({}).hostname).toBe("");
		expect(toSwarmNodeInfo({}).labels).toEqual({});
	});
});

describe("AgentClientService", () => {
	test("health and token checks report what went wrong", async () => {
		restoreStubs();
		stubFetch((call) =>
			call.url.endsWith("/v1/health")
				? { status: "ok", version: "1.0.49" }
				: call.headers.get("authorization") === "Bearer good"
					? {}
					: { body: {}, status: 401 },
		);
		expect(await AgentClientService.checkHealth("http://agent:7420")).toEqual({
			status: "ok",
			version: "1.0.49",
		});
		await AgentClientService.verifyToken("http://agent:7420", "good");
		await expect(
			AgentClientService.verifyToken("http://agent:7420", "bad"),
		).rejects.toThrow("rejected");
		stubFetch(() => ({ body: {}, status: 500 }));
		await expect(
			AgentClientService.checkHealth("http://agent:7420"),
		).rejects.toThrow("500");
		await expect(
			AgentClientService.verifyToken("http://agent:7420", "x"),
		).rejects.toThrow("500");
		stubFetch(() => {
			throw new Error("refused");
		});
		await expect(
			AgentClientService.checkHealth("http://agent:7420"),
		).rejects.toThrow("Couldn't reach");
		await expect(
			AgentClientService.verifyToken("http://agent:7420", "x"),
		).rejects.toThrow("Couldn't reach");
		stubFetch.restore();
	});
});
