import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { UptimeProbe, externalHostFor } = await import(
	"../../../src/lib/services/uptime/uptime-probe"
);
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { UptimeCheckDTO } = await import(
	"../../../src/lib/dto/uptime-check-dto"
);
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { DOWN_CONFIRM_FAILURES, StatusAlertService } = await import(
	"../../../src/lib/services/status-alert.service"
);
const { config } = await import("../../../src/lib/config");

type ProbeResult = Parameters<typeof UptimeCheckDTO.recordMany>[0][number];
type Service = Awaited<
	ReturnType<typeof ServiceDTO.listRunningWithContainers>
>[number];

const ESC = String.fromCharCode(27);

class TestProbe extends UptimeProbe {
	run(): Promise<void> {
		return this.tick();
	}
}

const realFetch = globalThis.fetch;
const realBaseDomain = config.baseDomain;
const realEntrypoint = config.traefik.entrypoint;
const spies: { mockRestore: () => void }[] = [];

function track<T extends { mockRestore: () => void }>(spy: T): T {
	spies.push(spy);
	return spy;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	config.baseDomain = realBaseDomain;
	config.traefik.entrypoint = realEntrypoint;
	for (const spy of spies.splice(0)) {
		spy.mockRestore();
	}
});

function svc(overrides: Record<string, unknown> = {}): Service {
	return {
		containerId: "ctr",
		containerPort: 8080,
		defaultDomainEnabled: true,
		dnsResolvable: false,
		domains: [],
		id: "svc",
		image: "nginx:alpine",
		primaryDomain: null,
		slug: "svc",
		swarmServiceId: null,
		uptimeEnabled: true,
		...overrides,
		toJSON() {
			return this;
		},
	} as unknown as Service;
}

interface Harness {
	dispatched: unknown[][];
	pruned: () => number;
	recorded: ProbeResult[][];
}

function harness(
	services: Service[],
	previous: Map<string, { ok: boolean }> = new Map(),
): Harness {
	const recorded: ProbeResult[][] = [];
	const dispatched: unknown[][] = [];
	track(
		spyOn(ServiceDTO, "listRunningWithContainers").mockResolvedValue(services),
	);
	track(
		spyOn(UptimeCheckDTO, "latestByProbe").mockResolvedValue(
			previous as Awaited<ReturnType<typeof UptimeCheckDTO.latestByProbe>>,
		),
	);
	track(
		spyOn(UptimeCheckDTO, "recordMany").mockImplementation(async (rows) => {
			recorded.push(rows);
		}),
	);
	const prune = track(
		spyOn(UptimeCheckDTO, "prune").mockResolvedValue(undefined),
	);
	track(
		spyOn(StatusAlertService, "dispatch").mockImplementation(
			async (transitions, byId) => {
				dispatched.push([transitions, byId]);
			},
		),
	);
	return {
		dispatched,
		pruned: () => prune.mock.calls.length,
		recorded,
	};
}

function stubDocker(
	health: { output: string | null; status: string } | null,
	address: string | null,
) {
	track(spyOn(DockerService, "containerHealth").mockResolvedValue(health));
	track(spyOn(DockerService, "containerAddress").mockResolvedValue(address));
}

describe("externalHostFor", () => {
	test("only a DNS-resolvable service has a public host", () => {
		config.baseDomain = "example.com";
		const fields = {
			defaultDomainEnabled: true,
			domains: [],
			primaryDomain: null,
			slug: "api",
		};
		expect(externalHostFor({ ...fields, dnsResolvable: false })).toBeNull();
		expect(externalHostFor({ ...fields, dnsResolvable: true })).toBe(
			"api.example.com",
		);
	});
});

describe("UptimeProbe tick", () => {
	test("skips disabled services and ones with no workload", async () => {
		const h = harness([
			svc({ id: "off", uptimeEnabled: false }),
			svc({ containerId: null, id: "none", swarmServiceId: null }),
		]);
		await new TestProbe().run();
		expect(h.recorded).toEqual([[]]);
		expect(h.dispatched).toHaveLength(0);
	});

	test("a Docker healthcheck is the internal probe when the image has one", async () => {
		const h = harness([
			svc({ id: "healthy" }),
			svc({ containerId: "c2", id: "sick" }),
		]);
		track(
			spyOn(DockerService, "containerHealth").mockImplementation(
				async (id: string) =>
					id === "ctr"
						? { output: null, status: "healthy" }
						: {
								output: `${ESC}[31mdb down${ESC}[0m\n`,
								status: "unhealthy",
							},
			),
		);
		await new TestProbe().run();
		expect(h.recorded[0]).toEqual([
			{
				detail: "Healthcheck: healthy",
				kind: "internal",
				ok: true,
				serviceId: "healthy",
				target: "docker healthcheck",
			},
			{
				detail: "Healthcheck: unhealthy · db down",
				kind: "internal",
				ok: false,
				serviceId: "sick",
				target: "docker healthcheck",
			},
		]);
	});

	test("a container with no network address is down", async () => {
		const h = harness([svc()]);
		stubDocker(null, null);
		await new TestProbe().run();
		expect(h.recorded[0]).toEqual([
			{
				detail: "The container has no address on the Docker network.",
				kind: "internal",
				ok: false,
				serviceId: "svc",
			},
		]);
	});

	test("an HTTP probe counts a non-5xx response as up, and a 5xx or a refusal as down", async () => {
		const h = harness([
			svc({ id: "a" }),
			svc({ containerId: "c2", id: "b" }),
			svc({ containerId: "c3", id: "c" }),
		]);
		track(spyOn(DockerService, "containerHealth").mockResolvedValue(null));
		const addresses: Record<string, string> = {
			c2: "10.0.0.3",
			c3: "10.0.0.4",
			ctr: "10.0.0.2",
		};
		track(
			spyOn(DockerService, "containerAddress").mockImplementation(
				async (id: string) => addresses[id] ?? null,
			),
		);
		const requests: { init: RequestInit; url: string }[] = [];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			requests.push({ init, url });
			if (url.includes("10.0.0.3")) {
				throw new Error("ConnectionRefused");
			}
			return new Response("", {
				status: url.includes("10.0.0.4") ? 503 : 401,
			});
		}) as unknown as typeof fetch;

		await new TestProbe().run();

		const [a, b, c] = h.recorded[0];
		expect(a).toMatchObject({
			detail: "HTTP 401",
			kind: "internal",
			ok: true,
			target: "http://10.0.0.2:8080/",
		});
		expect(b).toMatchObject({ detail: "Connection refused.", ok: false });
		expect(c).toMatchObject({ detail: "HTTP 503", ok: false });
		expect(requests[0].init.redirect).toBe("manual");
	});

	test("a certificate failure is retried unverified and reported as up", async () => {
		config.baseDomain = "example.com";
		const h = harness([
			svc({ containerId: null, dnsResolvable: true, swarmServiceId: "sw" }),
		]);
		track(
			spyOn(DockerService, "getRunningTaskContainerId").mockResolvedValue(null),
		);
		const verify: boolean[] = [];
		globalThis.fetch = (async (
			_url: string,
			init: RequestInit & { tls: { rejectUnauthorized: boolean } },
		) => {
			verify.push(init.tls.rejectUnauthorized);
			if (init.tls.rejectUnauthorized) {
				throw new Error("self-signed certificate");
			}
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		await new TestProbe().run();

		expect(verify).toEqual([true, false]);
		expect(h.recorded[0]).toEqual([
			expect.objectContaining({
				detail: "No running task on this node.",
				kind: "internal",
				ok: false,
			}),
			expect.objectContaining({
				detail:
					"HTTP 200 · certificate not trusted (self-signed, or not issued yet)",
				kind: "external",
				ok: true,
				target: "https://svc.example.com/",
			}),
		]);
	});

	test("a certificate failure that also fails unverified is down", async () => {
		config.baseDomain = "example.com";
		config.traefik.entrypoint = "web";
		const h = harness([
			svc({ containerId: null, dnsResolvable: true, swarmServiceId: "sw" }),
		]);
		track(
			spyOn(DockerService, "getRunningTaskContainerId").mockResolvedValue(null),
		);
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error(calls === 1 ? "certificate expired" : "timed out");
		}) as unknown as typeof fetch;

		await new TestProbe().run();

		expect(h.recorded[0]).toEqual([
			expect.objectContaining({
				detail: "No running task on this node.",
				kind: "internal",
				ok: false,
			}),
			expect.objectContaining({
				detail: "Timed out.",
				kind: "external",
				ok: false,
				target: "http://svc.example.com/",
			}),
		]);
	});

	test("a loopback public host is never probed externally", async () => {
		config.baseDomain = "localhost";
		const h = harness([
			svc({ containerId: null, dnsResolvable: true, swarmServiceId: "sw" }),
		]);
		track(
			spyOn(DockerService, "getRunningTaskContainerId").mockResolvedValue(null),
		);
		await new TestProbe().run();
		expect(h.recorded).toEqual([
			[
				expect.objectContaining({
					detail: "No running task on this node.",
					kind: "internal",
					ok: false,
				}),
			],
		]);
	});

	test("a swarm service is probed by its overlay alias via its running task", async () => {
		const h = harness([
			svc({ containerId: null, slug: "it-tools", swarmServiceId: "sw" }),
		]);
		track(
			spyOn(DockerService, "getRunningTaskContainerId").mockResolvedValue(
				"task-ctr",
			),
		);
		const health = spyOn(DockerService, "containerHealth").mockResolvedValue(
			null,
		);
		track(health);
		const address = spyOn(DockerService, "containerAddress");
		track(address);
		const urls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			urls.push(url);
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		await new TestProbe().run();

		expect(health).toHaveBeenCalledWith("task-ctr");
		expect(address).not.toHaveBeenCalled();
		expect(urls).toEqual(["http://it-tools:8080/"]);
		expect(h.recorded[0]).toEqual([
			expect.objectContaining({ kind: "internal", ok: true }),
		]);
	});

	test("a database image is probed over TCP", async () => {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data: () => {} },
		});
		const closed = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data: () => {} },
		});
		const closedPort = closed.port;
		closed.stop(true);
		try {
			const h = harness([
				svc({ containerPort: server.port, id: "up", image: "postgres:18" }),
				svc({
					containerId: "c2",
					containerPort: closedPort,
					id: "down",
					image: "redis:7",
				}),
			]);
			stubDocker(null, "127.0.0.1");
			await new TestProbe().run();
			const [up, down] = h.recorded[0];
			expect(up).toMatchObject({
				detail: "Port accepting connections",
				ok: true,
				target: `tcp://127.0.0.1:${server.port}`,
			});
			expect(down).toMatchObject({ kind: "internal", ok: false });
		} finally {
			server.stop(true);
		}
	});

	test("a down flip is dispatched with the public host once it has failed enough checks in a row", async () => {
		config.baseDomain = "example.com";
		const h = harness(
			[svc({ dnsResolvable: true })],
			new Map([
				["svc:internal", { ok: false }],
				["svc:external", { ok: true }],
			]),
		);
		stubDocker({ output: null, status: "healthy" }, null);
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts += 1;
			throw new Error("ConnectionRefused");
		}) as unknown as typeof fetch;
		const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);

		const probe = new TestProbe();
		for (let tick = 1; tick < DOWN_CONFIRM_FAILURES; tick++) {
			await probe.run();
		}
		expect(h.dispatched).toHaveLength(0);
		expect(attempts).toBe(2 * (DOWN_CONFIRM_FAILURES - 1));
		await probe.run();

		expect(h.dispatched).toHaveLength(1);
		const [transitions, byId] = h.dispatched[0] as [
			{ kind: string; ok: boolean }[],
			Map<string, { host: string | null }>,
		];
		expect(transitions.map((t) => [t.kind, t.ok])).toEqual([
			["external", false],
		]);
		expect(byId.get("svc")?.host).toBe("svc.example.com");
		sleep.mockRestore();
	});

	test("old checks are pruned once every sixty ticks", async () => {
		const h = harness([]);
		const probe = new TestProbe();
		for (let i = 0; i < 59; i++) {
			await probe.run();
		}
		expect(h.pruned()).toBe(0);
		await probe.run();
		expect(h.pruned()).toBe(1);
	});
});

describe("quiet windows", () => {
	test("a quiet window skips probing entirely, and resuming ends it", async () => {
		const { quietUptimeProbes, resumeUptimeProbes, uptimeProbesQuiet } =
			await import("../../../src/lib/services/uptime/quiet");
		const h = harness([svc({ id: "a" })]);
		quietUptimeProbes(60_000);
		expect(uptimeProbesQuiet()).toBe(true);
		await new TestProbe().run();
		expect(h.recorded).toHaveLength(0);

		quietUptimeProbes(1000, 0);
		expect(uptimeProbesQuiet()).toBe(true);
		resumeUptimeProbes();
		expect(uptimeProbesQuiet()).toBe(false);
	});
});
