import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { config } from "#lib/config.js";
import {
	generateWorkstationPassword,
	parseAutoStop,
	parseNewWorkstation,
	parseWorkstationSettings,
} from "#lib/server/workstation-form.js";
import {
	agentHostAddress,
	workstationLabels,
	workstationRouteFile,
	workstationRouter,
	workstationRouteYaml,
} from "#lib/services/workstation/routing.js";
import {
	autoStopLabel,
	autoStopStep,
	DEFAULT_WORKSTATION_HOME,
	DEFAULT_WORKSTATION_IMAGE,
	isWorkstationBusy,
	repoDirectory,
	WORKSTATION_STATES,
	workstationHostname,
	workstationStateLabel,
} from "#lib/workstations.js";

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		data.set(key, value);
	}
	return data;
}

describe("workstation states", () => {
	test("only an in-flight start is busy", () => {
		expect(
			WORKSTATION_STATES.filter((state) => isWorkstationBusy(state)),
		).toEqual(["pulling", "starting", "cloning"]);
	});

	test("every state reads as a label", () => {
		expect(WORKSTATION_STATES.map(workstationStateLabel)).toEqual([
			"Pulling image",
			"Starting",
			"Cloning repository",
			"Running",
			"Stopped",
			"Failed",
			"Not created",
		]);
	});
});

describe("repoDirectory", () => {
	test("is the repository's name without .git", () => {
		expect(repoDirectory("https://github.com/acme/web-app.git")).toBe(
			"web-app",
		);
		expect(repoDirectory("https://gitlab.com/group/sub/api/")).toBe("api");
	});

	test("falls back to project for anything unusable", () => {
		expect(repoDirectory("not a url")).toBe("project");
		expect(repoDirectory("https://example.com/")).toBe("project");
		expect(repoDirectory("https://example.com/..")).toBe("project");
	});
});

test("a workstation lives at <slug>.<baseDomain>", () => {
	expect(workstationHostname("alice-dev", "example.com")).toBe(
		"alice-dev.example.com",
	);
});

describe("routing", () => {
	test("local labels route the hostname to the container port on the shared network", () => {
		const labels = workstationLabels("alice", "alice.example.com", 8080);
		const router = workstationRouter("alice");
		expect(router).toBe("workstation-alice");
		expect(labels["traefik.enable"]).toBe("true");
		expect(labels["traefik.docker.network"]).toBe(config.docker.networkName);
		expect(labels[`traefik.http.routers.${router}.rule`]).toBe(
			"Host(`alice.example.com`)",
		);
		expect(
			labels[`traefik.http.services.${router}.loadbalancer.server.port`],
		).toBe("8080");
		expect(labels[`traefik.http.routers.${router}.tls`]).toBe("true");
	});

	test("an agent workstation's route points the hostname at the published port", () => {
		const router = workstationRouter("bob");
		const yaml = parse(
			workstationRouteYaml("bob", "bob.example.com", "http://10.0.0.5:49153"),
		);
		expect(yaml.http.routers[router].rule).toBe("Host(`bob.example.com`)");
		expect(yaml.http.routers[router].entryPoints).toEqual([
			config.traefik.entrypoint,
		]);
		expect(yaml.http.services[router].loadBalancer.servers).toEqual([
			{ url: "http://10.0.0.5:49153" },
		]);
		expect(workstationRouteFile("bob")).toBe("homerun-workstation-bob.yml");
	});

	test("an agent's address is its URL's hostname", () => {
		expect(agentHostAddress("http://10.0.0.5:7430")).toBe("10.0.0.5");
		expect(agentHostAddress("https://build.example.com")).toBe(
			"build.example.com",
		);
	});
});

describe("workstation forms", () => {
	test("blank fields fall back to the defaults", () => {
		const result = parseNewWorkstation(form({ name: " dev " }));
		expect(result).toEqual({
			parsed: {
				cpuLimit: null,
				env: {},
				gitBranch: null,
				gitUrl: null,
				homePath: DEFAULT_WORKSTATION_HOME,
				image: DEFAULT_WORKSTATION_IMAGE,
				memoryLimitMb: null,
				name: "dev",
				port: 8080,
				remoteHostId: null,
			},
		});
	});

	test("every field is parsed, and PASSWORD stays Homerun's", () => {
		const result = parseWorkstationSettings(
			form({
				cpuLimit: "1.5",
				env: "FOO=bar\nPASSWORD=nope\n# comment",
				gitBranch: "main",
				gitUrl: "https://github.com/acme/app.git",
				homePath: "/root",
				image: "ghcr.io/acme/devbox:1",
				memoryLimitMb: "4096",
				port: "3000",
			}),
		);
		expect(result).toEqual({
			parsed: {
				cpuLimit: 1.5,
				env: { FOO: "bar" },
				gitBranch: "main",
				gitUrl: "https://github.com/acme/app.git",
				homePath: "/root",
				image: "ghcr.io/acme/devbox:1",
				memoryLimitMb: 4096,
				port: 3000,
			},
		});
	});

	test("rejects what the worker would refuse", () => {
		const bad: Record<string, string>[] = [
			{ name: "" },
			{ gitUrl: "git@github.com:acme/app.git", name: "x" },
			{ gitBranch: "--upload-pack=x", name: "x" },
			{ homePath: "home", name: "x" },
			{ image: "two words", name: "x" },
			{ name: "x", port: "70000" },
			{ cpuLimit: "0", name: "x" },
			{ memoryLimitMb: "12.5", name: "x" },
		];
		for (const fields of bad) {
			expect("error" in parseNewWorkstation(form(fields))).toBe(true);
		}
	});

	test("generated passwords are long and distinct", () => {
		const first = generateWorkstationPassword();
		expect(first).toMatch(/^[A-Za-z0-9_-]{24}$/);
		expect(generateWorkstationPassword()).not.toBe(first);
	});
});

describe("auto-stop", () => {
	const now = new Date("2026-10-12T12:00:00Z");
	const later = new Date(now.getTime() + 30 * 60_000);
	const passed = new Date(now.getTime() - 1);

	test("autoStopStep arms, waits and stops", () => {
		const base = { active: false, minutes: 30, now };
		expect(autoStopStep({ ...base, autoStopAt: null, mode: "timer" })).toEqual({
			at: later,
			kind: "arm",
		});
		expect(autoStopStep({ ...base, autoStopAt: later, mode: "timer" })).toEqual(
			{ kind: "wait" },
		);
		expect(
			autoStopStep({ ...base, autoStopAt: passed, mode: "timer" }),
		).toEqual({ kind: "stop" });
		expect(
			autoStopStep({
				...base,
				active: true,
				autoStopAt: passed,
				mode: "timer",
			}),
		).toEqual({ kind: "stop" });
		expect(
			autoStopStep({ ...base, active: true, autoStopAt: passed, mode: "idle" }),
		).toEqual({ at: later, kind: "arm" });
		expect(autoStopStep({ ...base, autoStopAt: passed, mode: "idle" })).toEqual(
			{ kind: "stop" },
		);
	});

	test("parseAutoStop takes off, or a mode with sane minutes", () => {
		expect(parseAutoStop(form({ autoStopMode: "off" }))).toEqual({
			parsed: { minutes: null, mode: null },
		});
		expect(
			parseAutoStop(form({ autoStopMinutes: "45", autoStopMode: "idle" })),
		).toEqual({ parsed: { minutes: 45, mode: "idle" } });
		for (const minutes of ["", "2", "1.5", "20000"]) {
			expect(
				"error" in
					parseAutoStop(
						form({ autoStopMinutes: minutes, autoStopMode: "timer" }),
					),
			).toBe(true);
		}
		expect("error" in parseAutoStop(form({ autoStopMode: "sometimes" }))).toBe(
			true,
		);
	});

	test("autoStopLabel", () => {
		expect(autoStopLabel(null, null)).toBe("Off");
		expect(autoStopLabel("idle", 30)).toContain("no browser connected");
		expect(autoStopLabel("timer", 30)).toContain("after it starts");
	});
});
