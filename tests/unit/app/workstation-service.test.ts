import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import dns from "node:dns/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { WorkstationService, dockerRemoteHeader } = await import(
	"../../../src/lib/services/workstation.service"
);
const { WorkerClient } = await import("../../../src/lib/server/worker-client");
const { AgentClientService } = await import(
	"../../../src/lib/services/agent-client.service"
);
const { RemoteHostDTO } = await import("../../../src/lib/dto/remote-host-dto");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);
const { StatusPageDTO } = await import("../../../src/lib/dto/status-page-dto");
const helpers = await import("../../../src/lib/services/deploy/helpers");
const { PangolinService } = await import(
	"../../../src/lib/services/pangolin.service"
);
const { DomainDnsService } = await import(
	"../../../src/lib/services/domain-dns.service"
);
const dnsService = await import("../../../src/lib/services/dns.service");
const { WorkstationSignInService } = await import(
	"../../../src/lib/services/workstation/sign-in"
);

type Workstation = NonNullable<Awaited<ReturnType<typeof WorkstationDTO.get>>>;
type Host = NonNullable<Awaited<ReturnType<typeof RemoteHostDTO.get>>>;

const restorers: { mockRestore: () => void }[] = [];
const originalDir = config.traefik.dynamicConfigDir;
const originalOrigin = config.auth.origin;
const realFetch = globalThis.fetch;
let pangolinSync: ReturnType<typeof spyOn>;
let pangolinDelete: ReturnType<typeof spyOn>;

beforeEach(() => {
	config.auth.origin = undefined;
	pangolinSync = spyOn(PangolinService, "syncDnsRecord").mockResolvedValue(
		null,
	);
	pangolinDelete = spyOn(PangolinService, "deleteDnsRecord").mockResolvedValue(
		null,
	);
	restorers.push(
		pangolinSync,
		pangolinDelete,
		spyOn(DomainDnsService, "syncHostname").mockResolvedValue(null),
		spyOn(DomainDnsService, "deleteHostname").mockResolvedValue(null),
		spyOn(InstanceSettingsDTO, "get").mockResolvedValue({
			toJSON: () => ({}),
		} as unknown as Awaited<ReturnType<typeof InstanceSettingsDTO.get>>),
		spyOn(StatusPageDTO, "list").mockResolvedValue([]),
	);
});

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
	config.traefik.dynamicConfigDir = originalDir;
	config.auth.origin = originalOrigin;
	globalThis.fetch = realFetch;
});

function stubFetch(answer: (url: string) => Response | Promise<Response>) {
	globalThis.fetch = (async (input: URL | string) =>
		answer(String(input))) as typeof fetch;
}

function workstation(overrides: Record<string, unknown> = {}) {
	const row = {
		cpuLimit: 2,
		editorSettings: {},
		env: { FOO: "bar" },
		extensions: [] as string[],
		gitAuthorEmail: null as string | null,
		gitAuthorName: null as string | null,
		gitBranch: null,
		gitProviderId: null as string | null,
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

const DOCKER_CONNECTION = {
	dockerHost: "tcp://10.0.0.6:2376",
	id: "h2",
	tlsCa: "ca",
	tlsCert: "cert",
	tlsKey: "key",
};

function dockerHost() {
	restorers.push(
		spyOn(RemoteHostDTO, "get").mockResolvedValue({
			dockerHost: DOCKER_CONNECTION.dockerHost,
			kind: "docker",
			toAgentConnection: () => null,
			toDockerConnection: async () => DOCKER_CONNECTION,
		} as unknown as Host),
	);
}

describe("WorkstationService on a raw Docker host", () => {
	test("the header carries the daemon and its TLS material, not the row id", () => {
		expect(
			JSON.parse(
				Buffer.from(dockerRemoteHeader(DOCKER_CONNECTION), "base64").toString(),
			),
		).toEqual({
			dockerHost: "tcp://10.0.0.6:2376",
			sshHostKey: "",
			sshPrivateKey: "",
			tlsCa: "ca",
			tlsCert: "cert",
			tlsKey: "key",
		});
	});

	test("start goes through the local worker with the remote header and publishes the port", async () => {
		dockerHost();
		const request = spyOn(WorkerClient, "request").mockResolvedValue({});
		restorers.push(request);
		await WorkstationService.start(
			workstation({ gitUrl: null, remoteHostId: "h2" }),
		);
		const [method, path, options] = request.mock.calls[0] as [
			string,
			string,
			{ body: Record<string, unknown>; headers: Record<string, string> },
		];
		expect(method).toBe("PUT");
		expect(path).toBe("/v1/workstations/ws1");
		expect(options.headers).toEqual({
			"x-homerun-docker-remote": dockerRemoteHeader(DOCKER_CONNECTION),
		});
		expect(options.body).toMatchObject({
			labels: {},
			network: "",
			publish: true,
		});
	});

	test("a running one is routed at the Docker host's published port", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ws-route-"));
		config.traefik.dynamicConfigDir = dir;
		dockerHost();
		restorers.push(
			spyOn(WorkerClient, "request").mockResolvedValue({
				hostPort: 49160,
				state: "running",
			}),
		);
		await WorkstationService.view(workstation({ remoteHostId: "h2" }));
		expect(
			await readFile(join(dir, "homerun-workstation-alice.yml"), "utf8"),
		).toContain("http://10.0.0.6:49160");
		await rm(dir, { force: true, recursive: true });
	});

	test("its logs stream through the local worker with the remote header", async () => {
		dockerHost();
		const body = new ReadableStream<Uint8Array>();
		const stream = spyOn(WorkerClient, "stream").mockResolvedValue(body);
		restorers.push(stream);
		await WorkstationService.streamLogs(workstation({ remoteHostId: "h2" }));
		expect(stream).toHaveBeenCalledWith("/v1/workstations/ws1/logs", {
			headers: {
				"x-homerun-docker-remote": dockerRemoteHeader(DOCKER_CONNECTION),
			},
			query: { follow: "1", tail: "500" },
		});
	});

	test("an ssh:// Docker host gets its SSH key and host key in the header and is reached at its hostname", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ws-route-"));
		config.traefik.dynamicConfigDir = dir;
		const connection = {
			dockerHost: "ssh://deploy@10.0.0.7:2222",
			id: "h3",
			sshHostKey: "ssh-ed25519 AAAA",
			sshPrivateKey: "PRIVATE",
		};
		restorers.push(
			spyOn(RemoteHostDTO, "get").mockResolvedValue({
				dockerHost: connection.dockerHost,
				kind: "docker",
				toAgentConnection: () => null,
				toDockerConnection: async () => connection,
			} as unknown as Host),
		);
		const request = spyOn(WorkerClient, "request").mockResolvedValue({
			hostPort: 49161,
			state: "running",
		});
		restorers.push(request);
		await WorkstationService.view(workstation({ remoteHostId: "h3" }));
		const [, , options] = request.mock.calls[0] as [
			string,
			string,
			{ headers: Record<string, string> },
		];
		expect(
			JSON.parse(
				Buffer.from(
					options.headers["x-homerun-docker-remote"] ?? "",
					"base64",
				).toString(),
			),
		).toMatchObject({
			dockerHost: "ssh://deploy@10.0.0.7:2222",
			sshHostKey: "ssh-ed25519 AAAA",
			sshPrivateKey: "PRIVATE",
		});
		expect(
			await readFile(join(dir, "homerun-workstation-alice.yml"), "utf8"),
		).toContain("http://10.0.0.7:49161");
		await rm(dir, { force: true, recursive: true });
	});

	test("a host that's neither an agent nor a Docker daemon can't run one", async () => {
		restorers.push(
			spyOn(RemoteHostDTO, "get").mockResolvedValue({
				dockerHost: null,
				kind: "docker",
				toAgentConnection: () => null,
			} as unknown as Host),
		);
		await expect(
			WorkstationService.start(workstation({ remoteHostId: "h2" })),
		).rejects.toThrow("isn't a registered agent or Docker host");
	});
});

describe("WorkstationService.diskUsage", () => {
	test("measures the home path through the worker", async () => {
		const get = spyOn(WorkerClient, "get").mockResolvedValue({ bytes: 4096 });
		restorers.push(get);
		expect(await WorkstationService.diskUsage(workstation())).toBe(4096);
		expect(get).toHaveBeenCalledWith("/v1/workstations/ws1/disk", {
			path: "/home/coder",
		});
	});
});

describe("WorkstationService.removeAllOnHost", () => {
	test("removes each container, route and DNS on the host, skipping failures", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ws-route-"));
		config.traefik.dynamicConfigDir = dir;
		agentHost();
		const reachable = workstation({ id: "a", remoteHostId: "h1", slug: "a" });
		const unreachable = workstation({ id: "b", remoteHostId: "h1", slug: "b" });
		await Bun.write(join(dir, "homerun-workstation-a.yml"), "x");
		await Bun.write(join(dir, "homerun-workstation-b.yml"), "x");
		const request = spyOn(AgentClientService, "request").mockImplementation(
			(_connection, _method, path: string) =>
				path.endsWith("/b")
					? Promise.reject(new Error("agent down"))
					: Promise.resolve(null as never),
		);
		const deleteDns = spyOn(dnsService, "deleteDns").mockResolvedValue([]);
		restorers.push(
			request,
			deleteDns,
			spyOn(WorkstationDTO, "listOnHost").mockResolvedValue([
				reachable,
				unreachable,
			]),
		);
		await WorkstationService.removeAllOnHost("h1");
		expect(request).toHaveBeenCalledWith(
			expect.anything(),
			"DELETE",
			"/v1/workstations/a",
			{ query: { volume: "0" } },
		);
		for (const slug of ["a", "b"]) {
			expect(
				await readFile(
					join(dir, `homerun-workstation-${slug}.yml`),
					"utf8",
				).catch(() => null),
			).toBeNull();
		}
		expect(deleteDns).toHaveBeenCalledTimes(2);
		expect(reachable.delete).not.toHaveBeenCalled();
		await rm(dir, { force: true, recursive: true });
	});
});

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
			autoStopAt: null,
			desiredState: "running",
			lastError: null,
			signInWithGit: false,
		});
	});

	test("a workstation signing in through git turns code-server's password off behind forwardAuth", async () => {
		restorers.push(
			spyOn(WorkstationSignInService, "gateFor").mockResolvedValue({
				hostname: "alice.localhost",
				id: "ws1",
				ownerId: "u1",
				provider: {
					baseUrl: null,
					clientId: "c",
					clientSecretEnc: "s",
					enabled: true,
					id: "gh",
					kind: "github",
					name: "GitHub",
				},
				providerUsername: "alice",
				version: "v",
			}),
			spyOn(helpers, "resolveProviderCredential").mockResolvedValue(null),
		);
		const put = spyOn(WorkerClient, "put").mockResolvedValue({});
		restorers.push(put);
		const ws = workstation({ gitProviderId: "gh", gitUrl: null });
		await WorkstationService.start(ws);
		const [, spec] = put.mock.calls[0] as [
			string,
			{
				args: string[];
				env: Record<string, string>;
				labels: Record<string, string>;
			},
		];
		expect(spec.args).toEqual(["--auth", "none"]);
		expect(spec.env.PASSWORD).toBeUndefined();
		expect(
			spec.labels["traefik.http.routers.workstation-alice.middlewares"],
		).toBe("workstation-alice-auth");
		expect(
			spec.labels[
				"traefik.http.middlewares.workstation-alice-auth.forwardauth.address"
			],
		).toContain("workstation=ws1");
		expect(ws.update).toHaveBeenCalledWith(
			expect.objectContaining({ signInWithGit: true }),
		);
	});

	test("the IDE setup carries the extensions, settings and the picked provider's login", async () => {
		restorers.push(
			spyOn(helpers, "resolveProviderCredential").mockResolvedValue({
				host: "github.com",
				kind: "github",
				token: "gho_x",
				username: "alice",
			}),
		);
		const put = spyOn(WorkerClient, "put").mockResolvedValue({});
		restorers.push(put);
		await WorkstationService.start(
			workstation({
				editorSettings: { "editor.fontSize": 14 },
				extensions: ["golang.go"],
				gitAuthorEmail: "alice@example.com",
				gitProviderId: "gh",
				gitUrl: null,
			}),
		);
		const [, spec] = put.mock.calls[0] as [string, Record<string, unknown>];
		expect(spec).toMatchObject({
			env: { FOO: "bar", GH_TOKEN: "gho_x", PASSWORD: "pw" },
			setup: {
				credential: { host: "github.com", token: "gho_x", username: "alice" },
				extensions: ["golang.go"],
				gitEmail: "alice@example.com",
				gitName: "alice",
				settings: '{\n\t"editor.fontSize": 14\n}',
			},
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

	test("its hostname gets a Pangolin resource without Pangolin's sign-in", async () => {
		restorers.push(spyOn(WorkerClient, "put").mockResolvedValue({}));
		pangolinSync.mockResolvedValue({
			detail: "created",
			ok: true,
			provider: "pangolin",
		});
		const ws = workstation({ gitUrl: null });
		await WorkstationService.start(ws);
		expect(pangolinSync).toHaveBeenCalledWith(WorkstationService.hostname(ws), {
			sso: false,
		});
	});

	test("a failed DNS sync is stored as the last error", async () => {
		restorers.push(spyOn(WorkerClient, "put").mockResolvedValue({}));
		pangolinSync.mockResolvedValue({
			detail: "site not found",
			ok: false,
			provider: "pangolin",
		});
		const ws = workstation({ gitUrl: null });
		await expect(WorkstationService.start(ws)).rejects.toThrow(
			"site not found",
		);
		expect(ws.update).toHaveBeenCalledWith({
			autoStopAt: null,
			desiredState: "running",
			lastError: null,
			signInWithGit: false,
		});
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
		expect(ws.update).toHaveBeenCalledWith({
			autoStopAt: null,
			desiredState: "stopped",
		});
	});

	test("remove passes the volume choice and deletes the row", async () => {
		const del = spyOn(WorkerClient, "delete").mockResolvedValue({});
		restorers.push(del);
		const ws = workstation();
		await WorkstationService.remove(ws, true);
		expect(del).toHaveBeenCalledWith("/v1/workstations/ws1", { volume: "1" });
		expect(pangolinDelete).toHaveBeenCalledWith(
			WorkstationService.hostname(ws),
		);
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

describe("WorkstationService auto-stop", () => {
	const now = new Date("2026-10-12T12:00:00Z");

	test("start arms the countdown from the saved setting", async () => {
		restorers.push(spyOn(WorkerClient, "put").mockResolvedValue({}));
		const ws = workstation({
			autoStopMinutes: 30,
			autoStopMode: "timer",
			gitUrl: null,
		});
		const before = Date.now();
		await WorkstationService.start(ws);
		const armed = ws.update.mock.calls[0]?.[0] as { autoStopAt: Date };
		expect(armed.autoStopAt.getTime()).toBeGreaterThanOrEqual(
			before + 30 * 60_000,
		);
	});

	test("an open tab pushes an idle workstation's deadline out", async () => {
		const get = spyOn(WorkerClient, "get").mockResolvedValue({
			connections: 2,
		});
		restorers.push(get);
		const ws = workstation({
			autoStopAt: new Date(now.getTime() - 60_000),
			autoStopMinutes: 15,
			autoStopMode: "idle",
		});
		await WorkstationService.autoStop(ws, now);
		expect(get).toHaveBeenCalledWith("/v1/workstations/ws1/connections", {
			port: "8080",
		});
		expect(ws.update).toHaveBeenCalledWith({
			autoStopAt: new Date(now.getTime() + 15 * 60_000),
		});
	});

	test("an unreadable connection count never stops it", async () => {
		const post = spyOn(WorkerClient, "post").mockResolvedValue({});
		restorers.push(
			post,
			spyOn(WorkerClient, "get").mockRejectedValue(new Error("busy")),
		);
		const ws = workstation({
			autoStopAt: new Date(now.getTime() - 60_000),
			autoStopMinutes: 15,
			autoStopMode: "idle",
		});
		await WorkstationService.autoStop(ws, now);
		expect(post).not.toHaveBeenCalled();
	});

	test("a passed deadline stops it, idle or timed", async () => {
		const post = spyOn(WorkerClient, "post").mockResolvedValue({});
		restorers.push(
			post,
			spyOn(WorkerClient, "get").mockResolvedValue({ connections: 0 }),
		);
		for (const mode of ["idle", "timer"]) {
			const ws = workstation({
				autoStopAt: new Date(now.getTime() - 1),
				autoStopMinutes: 15,
				autoStopMode: mode,
			});
			await WorkstationService.autoStop(ws, now);
			expect(ws.update).toHaveBeenCalledWith({
				autoStopAt: null,
				desiredState: "stopped",
			});
		}
		expect(post).toHaveBeenCalledTimes(2);
	});

	test("setAutoStop restarts a running workstation's countdown and clears a stopped one's", async () => {
		const running = workstation({ desiredState: "running" });
		Object.assign(running, { desiredState: "running" });
		await WorkstationService.setAutoStop(running, "timer", 45);
		const saved = running.update.mock.calls[0]?.[0] as {
			autoStopAt: Date;
			autoStopMinutes: number;
		};
		expect(saved.autoStopMinutes).toBe(45);
		expect(saved.autoStopAt).toBeInstanceOf(Date);

		const stopped = workstation();
		Object.assign(stopped, { desiredState: "stopped" });
		await WorkstationService.setAutoStop(stopped, null, 45);
		expect(stopped.update).toHaveBeenCalledWith({
			autoStopAt: null,
			autoStopMinutes: null,
			autoStopMode: null,
		});
	});
});

describe("WorkstationService.streamLogs", () => {
	test("a local workstation follows the worker's log stream", async () => {
		const body = new ReadableStream<Uint8Array>();
		const stream = spyOn(WorkerClient, "stream").mockResolvedValue(body);
		restorers.push(stream);
		expect(await WorkstationService.streamLogs(workstation())).toBe(body);
		expect(stream).toHaveBeenCalledWith("/v1/workstations/ws1/logs", {
			query: { follow: "1", tail: "500" },
		});
	});

	test("an agent workstation follows the agent's", async () => {
		agentHost();
		const body = new ReadableStream<Uint8Array>();
		const stream = spyOn(AgentClientService, "stream").mockResolvedValue(body);
		restorers.push(stream);
		await WorkstationService.streamLogs(workstation({ remoteHostId: "h1" }));
		expect(stream.mock.calls[0]?.[1]).toBe("/v1/workstations/ws1/logs");
	});
});

describe("WorkstationService.selfTest", () => {
	function resolvesTo(address: string | null) {
		restorers.push(
			spyOn(dns, "lookup").mockImplementation((async () => {
				if (!address) {
					throw new Error("getaddrinfo ENOTFOUND");
				}
				return [{ address, family: 4 }];
			}) as never),
		);
	}

	test("a stopped container stops the test there", async () => {
		restorers.push(
			spyOn(WorkerClient, "get").mockResolvedValue({
				hostPort: 0,
				state: "stopped",
			}),
		);
		const checks = await WorkstationService.selfTest(workstation());
		expect(checks).toHaveLength(1);
		expect(checks[0]?.ok).toBe(false);
	});

	test("an unreachable worker is one failed check", async () => {
		restorers.push(
			spyOn(WorkerClient, "get").mockRejectedValue(new Error("worker down")),
		);
		const checks = await WorkstationService.selfTest(workstation());
		expect(checks).toEqual([
			{ detail: "worker down", label: "Container", ok: false },
		]);
	});

	test("a local workstation checks DNS and the route", async () => {
		restorers.push(
			spyOn(WorkerClient, "get").mockResolvedValue({
				hostPort: 0,
				state: "running",
			}),
		);
		resolvesTo("203.0.113.7");
		stubFetch(() => new Response(null, { status: 404 }));
		const checks = await WorkstationService.selfTest(workstation());
		expect(checks.map((check) => check.ok)).toEqual([true, true, false]);
		expect(checks[1]?.detail).toContain("203.0.113.7");
		expect(checks[2]?.detail).toContain("no router");
	});

	test("an unresolved host and a bad certificate both fail", async () => {
		restorers.push(
			spyOn(WorkerClient, "get").mockResolvedValue({
				hostPort: 0,
				state: "running",
			}),
		);
		resolvesTo(null);
		stubFetch(() => {
			throw new Error("unable to verify the first certificate");
		});
		const checks = await WorkstationService.selfTest(workstation());
		expect(checks[1]?.ok).toBe(false);
		expect(checks[2]?.detail).toContain("certificate doesn't verify");
	});

	test("an agent workstation checks its published port first", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ws-route-"));
		config.traefik.dynamicConfigDir = dir;
		agentHost();
		restorers.push(
			spyOn(AgentClientService, "request").mockResolvedValue({
				hostPort: 49153,
				state: "running",
			}),
		);
		resolvesTo("203.0.113.7");
		stubFetch((url) =>
			url.startsWith("http://10.0.0.5:49153")
				? new Response(null, { status: 302 })
				: new Response(null, { status: 502 }),
		);
		const checks = await WorkstationService.selfTest(
			workstation({ remoteHostId: "h1" }),
		);
		expect(checks.map((check) => check.ok)).toEqual([true, true, true, false]);
		expect(checks[3]?.detail).toContain("port 8080");
		await rm(dir, { force: true, recursive: true });
	});

	test("an agent workstation without a dynamic config directory can't be routed", async () => {
		config.traefik.dynamicConfigDir = undefined;
		agentHost();
		restorers.push(
			spyOn(AgentClientService, "request").mockResolvedValue({
				hostPort: 49153,
				state: "running",
			}),
		);
		stubFetch(() => {
			throw new Error("connect ECONNREFUSED");
		});
		const checks = await WorkstationService.selfTest(
			workstation({ remoteHostId: "h1" }),
		);
		expect(checks.map((check) => check.label)).toEqual([
			"Container",
			"Published port 10.0.0.5:49153",
			"Traefik route",
		]);
		expect(checks[1]?.detail).toContain("firewall");
	});
});
