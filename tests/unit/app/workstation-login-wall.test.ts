import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { policyVersion } = await import("../../../src/lib/server/app-gate");
const { gateTarget, serviceGateTarget } = await import(
	"../../../src/lib/server/gate-target"
);
const { invalidateGatedService } = await import(
	"../../../src/lib/server/gated-service-cache"
);
const loginWallOptions = await import(
	"../../../src/lib/server/login-wall-options"
);
const { updateWorkstationApiBody, workstationApiBody, workstationWallColumns } =
	await import("../../../src/lib/server/validation/infrastructure-api");
const { WorkerClient } = await import("../../../src/lib/server/worker-client");
const helpers = await import("../../../src/lib/services/deploy/helpers");
const { PangolinService } = await import(
	"../../../src/lib/services/pangolin.service"
);
const { DomainDnsService } = await import(
	"../../../src/lib/services/domain-dns.service"
);
const {
	WorkstationSignInService,
	workstationGateKey,
	workstationIdOf,
	workstationWall,
} = await import("../../../src/lib/services/workstation/sign-in");
const { WorkstationSettingsError, WorkstationSettingsService } = await import(
	"../../../src/lib/services/workstation/settings"
);
const { WorkstationService } = await import(
	"../../../src/lib/services/workstation.service"
);

type WorkstationRow = Parameters<typeof workstationWall>[0];
type Workstation = NonNullable<Awaited<ReturnType<typeof WorkstationDTO.get>>>;
type Service = NonNullable<Awaited<ReturnType<typeof ServiceDTO.get>>>;

const restorers: { mockRestore: () => void }[] = [];
const originalOrigin = config.auth.origin;

function row(overrides: Record<string, unknown> = {}): WorkstationRow {
	return {
		authAllowedEmails: ["*@example.com"],
		authAllowedGroups: [],
		authAllowedUserIds: [],
		authProviders: ["password"],
		authRequired: true,
		cpuLimit: null,
		desiredState: "running",
		domain: "ide.example.com",
		editorSettings: {},
		env: {},
		extensions: [],
		gitAuthorEmail: null,
		gitAuthorName: null,
		gitBranch: null,
		gitProviderId: null,
		gitUrl: null,
		homePath: "/home/coder",
		id: "ws1",
		image: "codercom/code-server:latest",
		memoryLimitMb: null,
		name: "Alice's box",
		port: 8080,
		remoteHostId: null,
		signInWithGit: false,
		slug: "alice",
		userId: "u1",
		...overrides,
	} as unknown as WorkstationRow;
}

function workstation(overrides: Record<string, unknown> = {}) {
	const data = row(overrides) as WorkstationRow & { desiredState: string };
	return {
		get desiredState() {
			return data.desiredState;
		},
		id: data.id,
		password: () => "pw",
		remoteHostId: data.remoteHostId,
		slug: data.slug,
		toJSON: () => data,
		toPublic: () => data,
		update: mock(async (input: Record<string, unknown>) => {
			Object.assign(data, input);
		}),
		userId: data.userId,
	} as unknown as Workstation & { update: ReturnType<typeof mock> };
}

beforeEach(() => {
	config.auth.origin = "https://homerun.example.com";
	WorkstationSignInService.forget("ws1");
	restorers.push(
		spyOn(loginWallOptions, "loginWallAvailability").mockResolvedValue({
			email: { emailOtp: false, magicLink: false },
			oauthProviders: new Set(["keycloak"]),
		}),
		spyOn(PangolinService, "syncDnsRecord").mockResolvedValue(null),
		spyOn(DomainDnsService, "syncHostname").mockResolvedValue(null),
	);
});

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
	config.auth.origin = originalOrigin;
});

describe("workstation gate keys", () => {
	test("a workstation key round-trips and a service id isn't one", () => {
		expect(workstationIdOf(workstationGateKey("ws1"))).toBe("ws1");
		expect(workstationIdOf("svc-1")).toBeNull();
	});
});

describe("workstationWall", () => {
	test("carries the policy, the one hostname, the gate key and the owner", () => {
		const wall = workstationWall(row());
		expect(wall).toEqual({
			authAllowedEmails: ["*@example.com"],
			authAllowedGroups: [],
			authAllowedUserIds: [],
			authProviders: ["password"],
			authRequired: true,
			domains: ["ide.example.com"],
			key: "workstation:ws1",
			name: "Alice's box",
			ownerId: "u1",
		});
		expect(policyVersion(wall)).toBe(
			policyVersion(
				workstationWall(row({ domain: "other.example.com", name: "x" })),
			),
		);
		expect(policyVersion(wall)).not.toBe(
			policyVersion(workstationWall(row({ authAllowedEmails: [] }))),
		);
	});
});

describe("gate targets", () => {
	test("a workstation key resolves to its cached wall, a missing one to null", async () => {
		const lookup = spyOn(WorkstationDTO, "getForGate").mockResolvedValue(
			workstation(),
		);
		restorers.push(lookup);
		expect(await gateTarget(workstationGateKey("ws1"))).toMatchObject({
			key: "workstation:ws1",
			ownerId: "u1",
		});
		expect(await WorkstationSignInService.wall("ws1")).toMatchObject({
			authRequired: true,
		});
		expect(lookup).toHaveBeenCalledTimes(1);
		WorkstationSignInService.forget("ws1");
		lookup.mockResolvedValue(null);
		expect(await gateTarget(workstationGateKey("ws1"))).toBeNull();
	});

	test("anything else resolves to the service with no owner", async () => {
		invalidateGatedService("svc-1");
		restorers.push(
			spyOn(ServiceDTO, "get").mockResolvedValue({
				authAllowedEmails: [],
				authAllowedGroups: ["admins"],
				authAllowedUserIds: [],
				authProviders: ["oauth:keycloak"],
				authRequired: true,
				domains: ["app.example.com", "example.com/api"],
				id: "svc-1",
				name: "App",
			} as unknown as Service),
		);
		const target = await gateTarget("svc-1");
		expect(target).toEqual({
			authAllowedEmails: [],
			authAllowedGroups: ["admins"],
			authAllowedUserIds: [],
			authProviders: ["oauth:keycloak"],
			authRequired: true,
			domains: ["app.example.com", "example.com/api"],
			key: "svc-1",
			name: "App",
			ownerId: null,
		});
		expect(await serviceGateTarget("svc-1")).toEqual(target);
		invalidateGatedService("svc-1");
	});
});

describe("the workstation REST body", () => {
	test("takes the login wall fields and de-duplicates the lists", () => {
		const body = workstationApiBody.parse({
			authAllowedEmails: ["a@example.com", "a@example.com"],
			authProviders: ["password"],
			authRequired: true,
			name: "Box",
		});
		expect(workstationWallColumns(body)).toEqual({
			authAllowedEmails: ["a@example.com"],
			authProviders: ["password"],
			authRequired: true,
		});
		expect(
			workstationWallColumns(updateWorkstationApiBody.parse({ name: "x" })),
		).toEqual({});
	});
});

describe("WorkstationSettingsService.update and the login wall", () => {
	test("refuses a wall with no method or a method that isn't enabled", async () => {
		const ws = workstation({ authProviders: [], authRequired: false });
		await expect(
			WorkstationSettingsService.update(ws, { authRequired: true }),
		).rejects.toBeInstanceOf(WorkstationSettingsError);
		await expect(
			WorkstationSettingsService.update(ws, {
				authProviders: ["oauth:github"],
			}),
		).rejects.toThrow("isn't an enabled sign-in method");
		expect(ws.update).not.toHaveBeenCalled();
	});

	test("refuses the wall without a Dashboard URL", async () => {
		config.auth.origin = undefined;
		await expect(
			WorkstationSettingsService.update(workstation({ authRequired: false }), {
				authRequired: true,
			}),
		).rejects.toThrow("Dashboard URL");
	});

	test("a policy change on a running workstation applies without a restart", async () => {
		const start = spyOn(WorkstationService, "start").mockResolvedValue();
		restorers.push(start);
		const ws = workstation();
		expect(
			await WorkstationSettingsService.update(ws, {
				authAllowedEmails: ["bob@example.com"],
			}),
		).toEqual({ restarted: false });
		expect(start).not.toHaveBeenCalled();
	});

	test("turning the wall on or off restarts a running workstation, not a stopped one", async () => {
		const start = spyOn(WorkstationService, "start").mockResolvedValue();
		restorers.push(start);
		const running = workstation({ authRequired: false });
		expect(
			await WorkstationSettingsService.update(running, { authRequired: true }),
		).toEqual({ restarted: true });
		expect(start).toHaveBeenCalledTimes(1);
		const stopped = workstation({
			authRequired: true,
			desiredState: "stopped",
		});
		expect(
			await WorkstationSettingsService.update(stopped, {
				authRequired: false,
			}),
		).toEqual({ restarted: false });
		expect(start).toHaveBeenCalledTimes(1);
	});
});

describe("WorkstationService.start behind the login wall", () => {
	test("a local code-server drops its password behind forwardAuth and skips the git gate", async () => {
		const gateFor = spyOn(WorkstationSignInService, "gateFor");
		const put = spyOn(WorkerClient, "put").mockResolvedValue({});
		restorers.push(
			gateFor,
			put,
			spyOn(helpers, "resolveProviderCredential").mockResolvedValue(null),
		);
		const ws = workstation({ gitProviderId: "gh" });
		await WorkstationService.start(ws);
		const [, spec] = put.mock.calls[0] as [
			string,
			{
				args: string[];
				env: Record<string, string>;
				labels: Record<string, string>;
			},
		];
		expect(gateFor).not.toHaveBeenCalled();
		expect(spec.args).toEqual(["--auth", "none"]);
		expect(spec.env.PASSWORD).toBeUndefined();
		expect(
			spec.labels[
				"traefik.http.middlewares.workstation-alice-auth.forwardauth.address"
			],
		).toContain("workstation=ws1");
		expect(ws.update).toHaveBeenCalledWith(
			expect.objectContaining({ signInWithGit: false }),
		);
	});

	test("an IDE other than code-server keeps its password behind the wall", async () => {
		const put = spyOn(WorkerClient, "put").mockResolvedValue({});
		restorers.push(put);
		const ws = workstation({ image: "gitpod/openvscode-server:latest" });
		await WorkstationService.start(ws);
		const [, spec] = put.mock.calls[0] as [
			string,
			{ args: string[]; env: Record<string, string> },
		];
		expect(spec.args).toEqual([]);
		expect(spec.env.PASSWORD).toBe("pw");
	});
});
