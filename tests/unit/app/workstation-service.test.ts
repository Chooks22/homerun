import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { WorkstationService } = await import(
	"../../../src/lib/services/workstation.service"
);
const { WorkerClient } = await import("../../../src/lib/server/worker-client");
const { AgentClientService } = await import(
	"../../../src/lib/services/agent-client.service"
);
const { RemoteHostDTO } = await import("../../../src/lib/dto/remote-host-dto");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const helpers = await import("../../../src/lib/services/deploy/helpers");

type Workstation = NonNullable<Awaited<ReturnType<typeof WorkstationDTO.get>>>;
type Host = NonNullable<Awaited<ReturnType<typeof RemoteHostDTO.get>>>;

const restorers: { mockRestore: () => void }[] = [];
const originalDir = config.traefik.dynamicConfigDir;

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
	config.traefik.dynamicConfigDir = originalDir;
});

function workstation(overrides: Record<string, unknown> = {}) {
	const row = {
		cpuLimit: 2,
		env: { FOO: "bar" },
		gitBranch: null,
		gitUrl: "https://github.com/acme/app.git",
		homePath: "/home/coder",
		id: "ws1",
		image: "codercom/code-server:latest",
		memoryLimitMb: 1024,
		port: 8080,
		remoteHostId: null as string | null,
		slug: "alice",
		userId: "u1",
		...overrides,
	};
	return {
		delete: mock(async () => {}),
		id: row.id,
		password: () => "pw",
		remoteHostId: row.remoteHostId,
		slug: row.slug,
		toJSON: () => row,
		update: mock(async () => {}),
		userId: row.userId,
	} as unknown as Workstation & {
		delete: ReturnType<typeof mock>;
		update: ReturnType<typeof mock>;
	};
}

function agentHost() {
	restorers.push(
		spyOn(RemoteHostDTO, "get").mockResolvedValue({
			toAgentConnection: () => ({
				agentUrl: "http://10.0.0.5:7430",
				token: "t",
			}),
		} as unknown as Host),
	);
}

describe("WorkstationService.start", () => {
	test("a local workstation joins the network with Traefik labels and its credential", async () => {
		restorers.push(
			spyOn(helpers, "resolveGitCredential").mockResolvedValue({
				token: "tok",
				username: "alice",
			}),
		);
		const put = spyOn(WorkerClient, "put").mockResolvedValue({});
		restorers.push(put);
		const ws = workstation();
		await WorkstationService.start(ws);
		const [path, spec] = put.mock.calls[0] as [
			string,
			{ labels: Record<string, string> },
		];
		expect(path).toBe("/v1/workstations/ws1");
		expect(spec).toMatchObject({
			env: { FOO: "bar", PASSWORD: "pw" },
			git: {
				branch: "",
				directory: "app",
				token: "tok",
				url: "https://github.com/acme/app.git",
				username: "alice",
			},
			memoryBytes: 1024 * 1024 * 1024,
			name: "homerun-ws-alice",
			nanoCpus: 2e9,
			network: config.docker.networkName,
			publish: false,
		});
		expect(spec.labels["traefik.enable"]).toBe("true");
		expect(ws.update).toHaveBeenCalledWith({
			desiredState: "running",
			lastError: null,
		});
	});

	test("an agent workstation publishes its port and carries no labels", async () => {
		agentHost();
		const request = spyOn(AgentClientService, "request").mockResolvedValue({});
		restorers.push(request);
		await WorkstationService.start(
			workstation({ gitUrl: null, remoteHostId: "h1" }),
		);
		const [, method, path, options] = request.mock.calls[0] as [
			unknown,
			string,
			string,
			{ body: Record<string, unknown> },
		];
		expect(method).toBe("PUT");
		expect(path).toBe("/v1/workstations/ws1");
		expect(options.body).toMatchObject({
			git: null,
			labels: {},
			network: "",
			publish: true,
		});
	});

	test("a failure is stored as the last error and rethrown", async () => {
		restorers.push(
			spyOn(WorkerClient, "put").mockRejectedValue(new Error("worker down")),
		);
		const ws = workstation({ gitUrl: null });
		await expect(WorkstationService.start(ws)).rejects.toThrow("worker down");
		expect(ws.update).toHaveBeenCalledWith({ lastError: "worker down" });
	});

	test("a host that isn't an agent any more is refused", async () => {
		restorers.push(spyOn(RemoteHostDTO, "get").mockResolvedValue(null));
		await expect(
			WorkstationService.start(workstation({ remoteHostId: "gone" })),
		).rejects.toThrow("isn't a registered agent");
	});
});

describe("WorkstationService.view", () => {
	test("a running local workstation opens at its hostname", async () => {
		restorers.push(
			spyOn(WorkerClient, "get").mockResolvedValue({
				hostPort: 0,
				state: "running",
			}),
		);
		const view = await WorkstationService.view(workstation());
		expect(view.url).toBe(`https://alice.${config.baseDomain}`);
	});

	test("a running agent workstation gets a file route, dropped once it stops", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ws-route-"));
		config.traefik.dynamicConfigDir = dir;
		agentHost();
		const request = spyOn(AgentClientService, "request").mockResolvedValue({
			hostPort: 49153,
			state: "running",
		});
		restorers.push(request);
		const ws = workstation({ remoteHostId: "h1" });
		const view = await WorkstationService.view(ws);
		expect(view.url).toBe(`https://alice.${config.baseDomain}`);
		const file = join(dir, "homerun-workstation-alice.yml");
		expect(await readFile(file, "utf8")).toContain("http://10.0.0.5:49153");

		request.mockResolvedValue({ hostPort: 0, state: "stopped" });
		expect((await WorkstationService.view(ws)).url).toBeNull();
		expect(await readFile(file, "utf8").catch(() => null)).toBeNull();
		await rm(dir, { force: true, recursive: true });
	});

	test("without a dynamic config directory an agent workstation opens at its published port", async () => {
		config.traefik.dynamicConfigDir = undefined;
		agentHost();
		restorers.push(
			spyOn(AgentClientService, "request").mockResolvedValue({
				hostPort: 49153,
				state: "running",
			}),
		);
		const view = await WorkstationService.view(
			workstation({ remoteHostId: "h1" }),
		);
		expect(view.url).toBe("http://10.0.0.5:49153");
	});
});

describe("WorkstationService stop and remove", () => {
	test("stop records the desired state", async () => {
		const post = spyOn(WorkerClient, "post").mockResolvedValue({});
		restorers.push(post);
		const ws = workstation();
		await WorkstationService.stop(ws);
		expect(post.mock.calls[0]?.[0]).toBe("/v1/workstations/ws1/stop");
		expect(ws.update).toHaveBeenCalledWith({ desiredState: "stopped" });
	});

	test("remove passes the volume choice and deletes the row", async () => {
		const del = spyOn(WorkerClient, "delete").mockResolvedValue({});
		restorers.push(del);
		const ws = workstation();
		await WorkstationService.remove(ws, true);
		expect(del).toHaveBeenCalledWith("/v1/workstations/ws1", { volume: "1" });
		expect(ws.delete).toHaveBeenCalled();
	});

	test("removeAllFor removes every one, skipping failures", async () => {
		const ok = workstation({ id: "a" });
		const broken = workstation({ id: "b" });
		restorers.push(
			spyOn(WorkstationDTO, "listForUser").mockResolvedValue([ok, broken]),
			spyOn(WorkerClient, "delete").mockImplementation((path: string) =>
				path.endsWith("/b")
					? Promise.reject(new Error("nope"))
					: Promise.resolve(null as never),
			),
		);
		await WorkstationService.removeAllFor("u1");
		expect(ok.delete).toHaveBeenCalled();
		expect(broken.delete).not.toHaveBeenCalled();
	});
});
