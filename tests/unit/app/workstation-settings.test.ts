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

const { config } = await import("../../../src/lib/config");
const { Logger } = await import("../../../src/lib/logger");
const { RemoteHostDTO } = await import("../../../src/lib/dto/remote-host-dto");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { WorkstationPresetDTO } = await import(
	"../../../src/lib/dto/workstation-preset-dto"
);
const loginWallOptions = await import(
	"../../../src/lib/server/login-wall-options"
);
const hostnameOwnerModule = await import(
	"../../../src/lib/server/hostname-owner"
);
const { decryptSecret } = await import("../../../src/lib/services/secrets");
const { WorkstationService } = await import(
	"../../../src/lib/services/workstation.service"
);
const { WorkstationSettingsError, WorkstationSettingsService } = await import(
	"../../../src/lib/services/workstation/settings"
);
const { DEFAULT_WORKSTATION_IMAGE, DEFAULT_WORKSTATION_PORT } = await import(
	"../../../src/lib/workstations"
);

type Preset = NonNullable<Awaited<ReturnType<typeof WorkstationPresetDTO.get>>>;
type Workstation = NonNullable<Awaited<ReturnType<typeof WorkstationDTO.get>>>;

const originalBaseDomain = config.baseDomain;
const originalOrigin = config.auth.origin;
const spies: { mockRestore: () => void }[] = [];
const hosts = new Map<string, { dockerHost: string | null; kind: string }>();
const takenSlugs = new Set<string>();
const owners = new Map<string, string>();
const createdRows: Record<string, unknown>[] = [];
const lifecycle: unknown[][] = [];
const warnings: string[] = [];
let startError: unknown = null;

beforeEach(() => {
	config.baseDomain = "example.com";
	config.auth.origin = "https://homerun.example.com";
	hosts.clear();
	takenSlugs.clear();
	owners.clear();
	createdRows.length = 0;
	lifecycle.length = 0;
	warnings.length = 0;
	startError = null;
	stub(RemoteHostDTO, "get", async (id: string) => hosts.get(id) ?? null);
	stub(WorkstationDTO, "slugTaken", async (slug: string) =>
		takenSlugs.has(slug),
	);
	stub(WorkstationDTO, "create", async (input: Record<string, unknown>) => {
		createdRows.push(input);
		return { id: "ws-new", ...input };
	});
	stub(
		WorkstationPresetDTO,
		"create",
		async (userId: string, input: Record<string, unknown>) => {
			createdRows.push({ userId, ...input });
			return { id: "preset-new" };
		},
	);
	stub(
		WorkstationService,
		"setAutoStop",
		async (ws: { id: string }, mode: unknown, minutes: unknown) => {
			lifecycle.push(["setAutoStop", ws.id, mode, minutes]);
		},
	);
	stub(WorkstationService, "start", async (ws: { id: string }) => {
		lifecycle.push(["start", ws.id]);
		if (startError) {
			throw startError;
		}
	});
	stub(WorkstationService, "stop", async (ws: { id: string }) => {
		lifecycle.push(["stop", ws.id]);
	});
	stub(Logger.prototype, "info", () => undefined);
	stub(Logger.prototype, "warn", (message: string) => {
		warnings.push(message);
	});
	spies.push(
		spyOn(loginWallOptions, "loginWallAvailability").mockResolvedValue({
			email: { emailOtp: false, magicLink: false },
			oauthProviders: new Set(["keycloak"]),
		}),
		spyOn(hostnameOwnerModule, "hostnameOwner").mockImplementation(
			async (hostname: string) => owners.get(hostname) ?? null,
		),
	);
});

afterEach(() => {
	restoreStubs();
	for (const spy of spies.splice(0)) {
		spy.mockRestore();
	}
	config.baseDomain = originalBaseDomain;
	config.auth.origin = originalOrigin;
});

function fakeWorkstation(desiredState: "running" | "stopped") {
	const row = { authRequired: false, desiredState, id: "ws1" };
	const updates: Record<string, unknown>[] = [];
	const ws = {
		get desiredState() {
			return row.desiredState;
		},
		id: row.id,
		toJSON: () => row,
		update: async (patch: Record<string, unknown>) => {
			updates.push(patch);
			Object.assign(row, patch);
		},
	};
	return { updates, ws: ws as unknown as Workstation };
}

describe("WorkstationSettingsService.create", () => {
	test("fills the defaults, picks a free slug and the default domain, then starts it", async () => {
		takenSlugs.add("alice-s-box");
		const ws = await WorkstationSettingsService.create("u1", {
			name: "Alice's box",
		});
		expect(ws.id).toBe("ws-new");
		const [row] = createdRows;
		expect(row).toMatchObject({
			domain: "alice-s-box-2.dev.example.com",
			image: DEFAULT_WORKSTATION_IMAGE,
			name: "Alice's box",
			port: DEFAULT_WORKSTATION_PORT,
			remoteHostId: null,
			slug: "alice-s-box-2",
			userId: "u1",
		});
		expect(decryptSecret(row.passwordEnc as string)).toBeTruthy();
		expect(lifecycle).toEqual([["start", "ws-new"]]);
	});

	test("keeps a custom domain without its trailing dot and applies auto-stop", async () => {
		await WorkstationSettingsService.create(
			"u1",
			{ domain: "ide.example.org.", name: "!!!" },
			{ autoStop: { minutes: 30, mode: "idle" }, start: false },
		);
		expect(createdRows[0]).toMatchObject({
			domain: "ide.example.org",
			slug: "workstation",
		});
		expect(lifecycle).toEqual([["setAutoStop", "ws-new", "idle", 30]]);
	});

	test("a start that fails is logged, the workstation is still created", async () => {
		startError = new Error("agent unreachable");
		const ws = await WorkstationSettingsService.create("u1", { name: "box" });
		expect(ws.id).toBe("ws-new");
		expect(warnings).toEqual([
			"Workstation created but didn't start: workstation=ws-new",
		]);
	});

	test("refuses a routed hostname with a 409", async () => {
		owners.set("box.dev.example.com", 'the service "web"');
		const error = await WorkstationSettingsService.create("u1", {
			name: "box",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(WorkstationSettingsError);
		expect(error).toMatchObject({
			message:
				'box.dev.example.com is already routed to the service "web". Pick another domain for the workstation.',
			status: 409,
		});
		expect(createdRows).toEqual([]);
	});

	test("refuses a host that can't run a workstation, accepts an agent", async () => {
		hosts.set("no-daemon", { dockerHost: null, kind: "docker" });
		hosts.set("agent-host", { dockerHost: null, kind: "agent" });
		await expect(
			WorkstationSettingsService.create("u1", {
				name: "box",
				remoteHostId: "no-daemon",
			}),
		).rejects.toThrow(
			"Workstations run on this server, an agent host or a Docker host.",
		);
		await WorkstationSettingsService.create(
			"u1",
			{ name: "box", remoteHostId: "agent-host" },
			{ start: false },
		);
		expect(createdRows[0]).toMatchObject({ remoteHostId: "agent-host" });
	});

	test("refuses auto-stop without minutes and a login wall with no method", async () => {
		await expect(
			WorkstationSettingsService.create(
				"u1",
				{ name: "box" },
				{ autoStop: { minutes: null, mode: "idle" } },
			),
		).rejects.toThrow("Give the auto-stop delay in minutes.");
		await expect(
			WorkstationSettingsService.create("u1", {
				authRequired: true,
				name: "box",
			}),
		).rejects.toBeInstanceOf(WorkstationSettingsError);
		expect(createdRows).toEqual([]);
	});
});

describe("WorkstationSettingsService.update", () => {
	test("saves the columns and auto-stop, turned off when its mode is null", async () => {
		const { updates, ws } = fakeWorkstation("stopped");
		const result = await WorkstationSettingsService.update(ws, {
			autoStop: { minutes: 15, mode: null },
			image: "custom/ide:1",
		});
		expect(result).toEqual({ restarted: false });
		expect(updates).toEqual([{ image: "custom/ide:1" }]);
		expect(lifecycle).toEqual([["setAutoStop", "ws1", null, null]]);
	});

	test("starts or stops it when asked for the other state only", async () => {
		const stopped = fakeWorkstation("stopped");
		await WorkstationSettingsService.update(stopped.ws, {
			desiredState: "running",
		});
		const running = fakeWorkstation("running");
		await WorkstationSettingsService.update(running.ws, {
			desiredState: "stopped",
		});
		await WorkstationSettingsService.update(running.ws, {
			desiredState: "running",
		});
		expect(lifecycle).toEqual([
			["start", "ws1"],
			["stop", "ws1"],
		]);
		expect(stopped.updates).toEqual([]);
	});
});

describe("WorkstationSettingsService presets", () => {
	test("a new preset gets the defaults under what was sent", async () => {
		const preset = await WorkstationSettingsService.createPreset("u1", {
			name: "Go",
			port: 9000,
		});
		expect(preset.id).toBe("preset-new");
		expect(createdRows[0]).toMatchObject({
			authProviders: [],
			authRequired: false,
			description: null,
			image: DEFAULT_WORKSTATION_IMAGE,
			name: "Go",
			port: 9000,
			remoteHostId: null,
			userId: "u1",
		});
	});

	test("a preset keeps a login wall it can use and refuses one it can't", async () => {
		await WorkstationSettingsService.createPreset("u1", {
			authProviders: ["oauth:keycloak"],
			authRequired: true,
			name: "Walled",
		});
		expect(createdRows[0]).toMatchObject({
			authProviders: ["oauth:keycloak"],
			authRequired: true,
		});
		await expect(
			WorkstationSettingsService.createPreset("u1", {
				authRequired: true,
				name: "Locked out",
			}),
		).rejects.toBeInstanceOf(WorkstationSettingsError);
		await expect(
			WorkstationSettingsService.createPreset("u1", {
				authProviders: ["magic-link"],
				name: "Unavailable",
			}),
		).rejects.toThrow("isn't an enabled sign-in method");
		expect(createdRows).toHaveLength(1);
	});

	test("a preset on a host that can't run workstations is refused", async () => {
		await expect(
			WorkstationSettingsService.createPreset("u1", {
				name: "Go",
				remoteHostId: "missing",
			}),
		).rejects.toThrow(WorkstationSettingsError);
		expect(createdRows).toEqual([]);
	});

	test("updating saves only what was sent, nothing when nothing was", async () => {
		const saved: unknown[] = [];
		const preset = {
			id: "p1",
			toJSON: () => ({
				authAllowedEmails: [],
				authAllowedGroups: [],
				authAllowedUserIds: [],
				authProviders: ["password"],
				authRequired: false,
			}),
			update: async (input: unknown) => {
				saved.push(input);
			},
		} as unknown as Preset;
		await WorkstationSettingsService.updatePreset(preset, {});
		hosts.set("tcp-host", { dockerHost: "tcp://h:2376", kind: "docker" });
		await WorkstationSettingsService.updatePreset(preset, {
			remoteHostId: "tcp-host",
		});
		await expect(
			WorkstationSettingsService.updatePreset(preset, {
				remoteHostId: "missing",
			}),
		).rejects.toThrow(WorkstationSettingsError);
		await WorkstationSettingsService.updatePreset(preset, {
			authRequired: true,
		});
		config.auth.origin = undefined;
		await expect(
			WorkstationSettingsService.updatePreset(preset, {
				authAllowedEmails: ["*@example.com"],
			}),
		).resolves.toBeUndefined();
		await expect(
			WorkstationSettingsService.updatePreset(preset, {
				authRequired: true,
			}),
		).rejects.toThrow("Dashboard URL");
		expect(saved).toEqual([
			{ remoteHostId: "tcp-host" },
			{ authRequired: true },
			{ authAllowedEmails: ["*@example.com"] },
		]);
	});
});
