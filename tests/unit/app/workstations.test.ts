import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { config } from "#lib/config.js";
import {
	generateWorkstationPassword,
	parseAutoStop,
	parseNewWorkstation,
	parseWorkstationPreset,
	parseWorkstationSection,
} from "#lib/server/workstation-form.js";
import { presetFromWorkstation } from "#lib/server/workstation-presets.js";
import {
	remoteHostAddress,
	workstationAuthCheckUrl,
	workstationLabels,
	workstationRouteFile,
	workstationRouter,
	workstationRouteYaml,
} from "#lib/services/workstation/routing.js";
import {
	isCodeServerImage,
	workstationGateKey,
} from "#lib/services/workstation/sign-in.js";
import {
	autoStopLabel,
	autoStopStep,
	DEFAULT_WORKSTATION_HOME,
	DEFAULT_WORKSTATION_IMAGE,
	defaultWorkstationDomain,
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
		).toEqual(["pulling", "starting", "cloning", "configuring"]);
	});

	test("every state reads as a label", () => {
		expect(WORKSTATION_STATES.map(workstationStateLabel)).toEqual([
			"Pulling image",
			"Starting",
			"Cloning repository",
			"Setting up the IDE",
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

test("a workstation lives at its own domain, or <slug>.<baseDomain> from before domains", () => {
	expect(defaultWorkstationDomain("penombre", "example.com")).toBe(
		"penombre.dev.example.com",
	);
	expect(
		workstationHostname(
			{ domain: "ide.example.org", slug: "alice-dev" },
			"example.com",
		),
	).toBe("ide.example.org");
	expect(
		workstationHostname({ domain: null, slug: "alice-dev" }, "example.com"),
	).toBe("alice-dev.example.com");
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

	test("without git sign-in a route carries no forwardAuth", () => {
		const labels = workstationLabels("alice", "alice.example.com", 8080);
		expect(Object.keys(labels).some((key) => key.includes("forwardauth"))).toBe(
			false,
		);
		const yaml = parse(
			workstationRouteYaml("bob", "bob.example.com", "http://10.0.0.5:1"),
		);
		expect(yaml.http.middlewares).toBeUndefined();
		expect(
			yaml.http.routers[workstationRouter("bob")].middlewares,
		).toBeUndefined();
	});

	test("git sign-in puts both route shapes behind the workstation's forwardAuth", () => {
		const address = workstationAuthCheckUrl("ws 1");
		expect(address).toBe(`${config.authCheckUrl}?workstation=ws%201`);
		const labels = workstationLabels(
			"alice",
			"alice.example.com",
			8080,
			address,
		);
		expect(labels["traefik.http.routers.workstation-alice.middlewares"]).toBe(
			"workstation-alice-auth",
		);
		expect(
			labels[
				"traefik.http.middlewares.workstation-alice-auth.forwardauth.address"
			],
		).toBe(address);
		const yaml = parse(
			workstationRouteYaml(
				"bob",
				"bob.example.com",
				"http://10.0.0.5:1",
				address,
			),
		);
		expect(yaml.http.routers["workstation-bob"].middlewares).toEqual([
			"workstation-bob-auth",
		]);
		expect(
			yaml.http.middlewares["workstation-bob-auth"].forwardAuth.address,
		).toBe(address);
	});

	test("only code-server images get their own password turned off", () => {
		expect(isCodeServerImage("codercom/code-server:latest")).toBe(true);
		expect(isCodeServerImage("ghcr.io/coder/code-server")).toBe(true);
		expect(isCodeServerImage("lscr.io/linuxserver/code-server:4")).toBe(true);
		expect(isCodeServerImage("gitpod/openvscode-server")).toBe(false);
		expect(isCodeServerImage("acme/code-server-fork")).toBe(false);
	});

	test("a workstation's gate key can't collide with a service id", () => {
		expect(workstationGateKey("abc")).toBe("workstation:abc");
	});

	test("a remote host's address is its agent URL's or Docker address's hostname", () => {
		expect(remoteHostAddress("http://10.0.0.5:7430")).toBe("10.0.0.5");
		expect(remoteHostAddress("https://build.example.com")).toBe(
			"build.example.com",
		);
		expect(remoteHostAddress("tcp://10.0.0.6:2376")).toBe("10.0.0.6");
		expect(remoteHostAddress("ssh://deploy@10.0.0.7:2222")).toBe("10.0.0.7");
	});
});

describe("workstation presets", () => {
	test("a preset needs a name and keeps its description", () => {
		expect(parseWorkstationPreset(form({ name: " " }))).toEqual({
			error: "Give the preset a name.",
		});
		const result = parseWorkstationPreset(
			form({
				description: " node box ",
				env: "A=1\nPASSWORD=x",
				name: "Node",
				remoteHostId: "",
			}),
		);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.parsed).toMatchObject({
			authProviders: [],
			authRequired: false,
			description: "node box",
			env: { A: "1" },
			homePath: DEFAULT_WORKSTATION_HOME,
			image: DEFAULT_WORKSTATION_IMAGE,
			name: "Node",
			remoteHostId: null,
		});
	});

	test("a preset's form carries its login wall", () => {
		const data = form({
			authAllowedEmails: "a@example.com\n*@example.org",
			authAllowedGroups: "dev, ops",
			authRequired: "on",
			name: "Walled",
		});
		data.append("authProvider", "password");
		data.append("authProvider", "password");
		data.append("authAllowedUserId", "u2");
		const result = parseWorkstationPreset(data);
		if ("error" in result) {
			throw new Error(result.error);
		}
		expect(result.parsed).toMatchObject({
			authAllowedEmails: ["a@example.com", "*@example.org"],
			authAllowedGroups: ["dev", "ops"],
			authAllowedUserIds: ["u2"],
			authProviders: ["password"],
			authRequired: true,
			name: "Walled",
		});
	});

	test("saving a workstation as a preset copies its settings, not its identity", () => {
		const preset = presetFromWorkstation(
			{
				authAllowedEmails: ["*@example.com"],
				authAllowedGroups: [],
				authAllowedUserIds: [],
				authProviders: ["password"],
				authRequired: true,
				autoStopAt: null,
				autoStopMinutes: 30,
				autoStopMode: "idle",
				cpuLimit: 2,
				createdAt: new Date(),
				desiredState: "running",
				domain: "dev.dev.example.com",
				editorSettings: { "editor.tabSize": 2 },
				env: { A: "1" },
				extensions: ["esbenp.prettier-vscode"],
				gitAuthorEmail: "a@example.com",
				gitAuthorName: "A",
				gitBranch: "main",
				gitProviderId: "gh",
				gitUrl: "https://github.com/acme/app.git",
				homePath: "/home/coder",
				id: "ws1",
				image: "codercom/code-server:4",
				lastError: "boom",
				memoryLimitMb: 2048,
				name: "dev",
				port: 8080,
				remoteHostId: "h1",
				signInWithGit: true,
				slug: "dev",
				updatedAt: new Date(),
				userId: "u1",
			},
			"Node",
			null,
		);
		expect(preset).toEqual({
			authAllowedEmails: ["*@example.com"],
			authAllowedGroups: [],
			authAllowedUserIds: [],
			authProviders: ["password"],
			authRequired: true,
			cpuLimit: 2,
			description: null,
			editorSettings: { "editor.tabSize": 2 },
			env: { A: "1" },
			extensions: ["esbenp.prettier-vscode"],
			gitAuthorEmail: "a@example.com",
			gitAuthorName: "A",
			gitBranch: "main",
			gitProviderId: "gh",
			gitUrl: "https://github.com/acme/app.git",
			homePath: "/home/coder",
			image: "codercom/code-server:4",
			memoryLimitMb: 2048,
			name: "Node",
			port: 8080,
			remoteHostId: "h1",
		});
	});
});

describe("workstation forms", () => {
	test("blank fields fall back to the defaults", () => {
		const result = parseNewWorkstation(form({ name: " dev " }));
		expect(result).toEqual({
			parsed: {
				authAllowedEmails: [],
				authAllowedGroups: [],
				authAllowedUserIds: [],
				authProviders: [],
				authRequired: false,
				cpuLimit: null,
				domain: null,
				editorSettings: {},
				env: {},
				extensions: [],
				gitAuthorEmail: null,
				gitAuthorName: null,
				gitBranch: null,
				gitProviderId: null,
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

	test("a picked domain is lowercased and must be a hostname", () => {
		const ok = parseNewWorkstation(
			form({ domain: " IDE.Example.com. ", name: "dev" }),
		);
		expect("parsed" in ok && ok.parsed.domain).toBe("ide.example.com");
		expect(
			parseNewWorkstation(form({ domain: "not a host", name: "dev" })),
		).toEqual({
			error: "The domain must be a hostname, like ide.example.com.",
		});
	});

	test("each section parses only its own fields, and PASSWORD stays Homerun's", () => {
		const container = parseWorkstationSection(
			"container",
			form({
				cpuLimit: "1.5",
				env: "FOO=bar\nPASSWORD=nope\n# comment",
				gitUrl: "https://github.com/acme/app.git",
				homePath: "/root",
				image: "ghcr.io/acme/devbox:1",
				memoryLimitMb: "4096",
				port: "3000",
			}),
		);
		expect(container).toEqual({
			parsed: {
				cpuLimit: 1.5,
				env: { FOO: "bar" },
				homePath: "/root",
				image: "ghcr.io/acme/devbox:1",
				memoryLimitMb: 4096,
				port: 3000,
			},
		});
		expect(
			parseWorkstationSection(
				"repository",
				form({ gitBranch: "main", gitUrl: "https://github.com/acme/app.git" }),
			),
		).toEqual({
			parsed: { gitBranch: "main", gitUrl: "https://github.com/acme/app.git" },
		});
		expect(
			parseWorkstationSection(
				"git",
				form({
					gitAuthorEmail: "ada@example.com",
					gitAuthorName: " Ada ",
					gitProviderId: "gh",
				}),
			),
		).toEqual({
			parsed: {
				gitAuthorEmail: "ada@example.com",
				gitAuthorName: "Ada",
				gitProviderId: "gh",
			},
		});
	});

	test("the editor section keeps every extension once and wants a JSON object", () => {
		const data = form({ editorSettings: '{"editor.fontSize": 14}' });
		for (const id of ["golang.Go", "esbenp.prettier-vscode", "golang.go"]) {
			data.append("extensions", id);
		}
		expect(parseWorkstationSection("editor", data)).toEqual({
			parsed: {
				editorSettings: { "editor.fontSize": 14 },
				extensions: ["golang.go", "esbenp.prettier-vscode"],
			},
		});
		for (const editorSettings of ["[1]", "{nope", "42"]) {
			expect(
				"error" in parseWorkstationSection("editor", form({ editorSettings })),
			).toBe(true);
		}
		const bad = form({});
		bad.append("extensions", "--force");
		expect("error" in parseWorkstationSection("editor", bad)).toBe(true);
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
			{ gitAuthorEmail: "not-an-email", name: "x" },
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
