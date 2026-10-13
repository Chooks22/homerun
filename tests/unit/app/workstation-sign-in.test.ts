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
const gitProviders = await import(
	"../../../src/lib/services/git-provider.service"
);
const { GitConnectionDTO } = await import(
	"../../../src/lib/dto/git-connection-dto"
);
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { RemoteHostDTO } = await import("../../../src/lib/dto/remote-host-dto");
const { signGateToken, verifyGateToken, GATE_CALLBACK_PATH } = await import(
	"../../../src/lib/server/app-gate"
);
const { agentHostProblem } = await import(
	"../../../src/lib/server/workstation-presets"
);
const { WorkstationSignInService, workstationGateKey } = await import(
	"../../../src/lib/services/workstation/sign-in"
);

type Connection = NonNullable<
	Awaited<ReturnType<typeof GitConnectionDTO.getForUserAndProvider>>
>;
type Ws = NonNullable<Awaited<ReturnType<typeof WorkstationDTO.getForGate>>>;
type Host = NonNullable<Awaited<ReturnType<typeof RemoteHostDTO.get>>>;

const provider = {
	baseUrl: null,
	clientId: "client",
	clientSecretEnc: "secret",
	enabled: true,
	id: "gh",
	kind: "github" as const,
	name: "GitHub",
};

const restorers: { mockRestore: () => void }[] = [];
const originalOrigin = config.auth.origin;

function row(overrides: Record<string, unknown> = {}) {
	return {
		gitProviderId: "gh",
		id: "ws1",
		slug: "alice",
		userId: "u1",
		...overrides,
	} as unknown as Parameters<typeof WorkstationSignInService.gateFor>[0];
}

function connected(username = "Alice") {
	restorers.push(
		spyOn(gitProviders, "enabledGitProvider").mockResolvedValue(provider),
		spyOn(GitConnectionDTO, "getForUserAndProvider").mockResolvedValue({
			toJSON: () => ({ providerUsername: username }),
		} as unknown as Connection),
	);
}

beforeEach(() => {
	config.auth.origin = "https://homerun.example.com";
	WorkstationSignInService.forget("ws1");
});

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
	config.auth.origin = originalOrigin;
});

describe("WorkstationSignInService.gateFor", () => {
	test("no git provider, or no dashboard URL, means no git sign-in", async () => {
		expect(
			await WorkstationSignInService.gateFor(row({ gitProviderId: null })),
		).toBeNull();
		config.auth.origin = undefined;
		expect(await WorkstationSignInService.gateFor(row())).toBeNull();
	});

	test("a disabled provider or a missing connection means no git sign-in", async () => {
		restorers.push(
			spyOn(gitProviders, "enabledGitProvider").mockResolvedValueOnce(null),
		);
		expect(await WorkstationSignInService.gateFor(row())).toBeNull();
		restorers.push(
			spyOn(gitProviders, "enabledGitProvider").mockResolvedValue(provider),
			spyOn(GitConnectionDTO, "getForUserAndProvider").mockResolvedValue(null),
		);
		expect(await WorkstationSignInService.gateFor(row())).toBeNull();
	});

	test("a connected owner gets a gate whose version follows the account", async () => {
		connected();
		const gate = await WorkstationSignInService.gateFor(row());
		expect(gate).toMatchObject({
			hostname: `alice.${config.baseDomain}`,
			id: "ws1",
			ownerId: "u1",
			provider,
			providerUsername: "Alice",
		});
		for (const spy of restorers.splice(0)) {
			spy.mockRestore();
		}
		connected("mallory");
		const other = await WorkstationSignInService.gateFor(row());
		expect(other?.version).not.toBe(gate?.version);
	});
});

describe("WorkstationSignInService.gate", () => {
	test("caches a lookup until it's forgotten", async () => {
		connected();
		const lookup = spyOn(WorkstationDTO, "getForGate").mockResolvedValue({
			toPublic: () => row(),
		} as unknown as Ws);
		restorers.push(lookup);
		await WorkstationSignInService.gate("ws1");
		await WorkstationSignInService.gate("ws1");
		expect(lookup).toHaveBeenCalledTimes(1);
		WorkstationSignInService.forget("ws1");
		await WorkstationSignInService.gate("ws1");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	test("a missing workstation has no gate", async () => {
		restorers.push(spyOn(WorkstationDTO, "getForGate").mockResolvedValue(null));
		expect(await WorkstationSignInService.gate("ws1")).toBeNull();
	});
});

describe("the sign-in round trip", () => {
	async function gate() {
		connected();
		restorers.push(
			spyOn(WorkstationDTO, "getForGate").mockResolvedValue({
				toPublic: () => row(),
			} as unknown as Ws),
		);
		const found = await WorkstationSignInService.gate("ws1");
		if (!found) {
			throw new Error("no gate");
		}
		return found;
	}

	test("the challenge goes to the provider with a workstation state and the registered callback", async () => {
		const g = await gate();
		const url = new URL(
			WorkstationSignInService.challengeUrl(g, g.hostname, "https://x/y"),
		);
		expect(url.origin).toBe("https://github.com");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://homerun.example.com/api/v1/git-providers/gh/callback",
		);
		const state = url.searchParams.get("state") ?? "";
		expect(WorkstationSignInService.ownsState(state)).toBe(true);
		expect(WorkstationSignInService.ownsState("abc")).toBe(false);
		expect(verifyGateToken(state.slice(3))).toMatchObject({
			host: g.hostname,
			serviceId: workstationGateKey("ws1"),
			target: "https://x/y",
		});
	});

	test("the owner's account gets a grant back on the workstation's host", async () => {
		const g = await gate();
		restorers.push(
			spyOn(gitProviders.GitProviderService, "exchangeCode").mockResolvedValue({
				accessToken: "t",
				expiresAt: null,
				providerUsername: "alice",
				refreshToken: null,
			}),
		);
		const state = `ws.${signGateToken(
			{
				host: g.hostname,
				serviceId: workstationGateKey("ws1"),
				target: `https://${g.hostname}/?folder=/home`,
			},
			60_000,
		)}`;
		const url = new URL(
			await WorkstationSignInService.complete("gh", "code", state),
		);
		expect(url.host).toBe(g.hostname);
		expect(url.pathname).toBe(GATE_CALLBACK_PATH);
		expect(verifyGateToken(url.searchParams.get("token") ?? "")).toMatchObject({
			serviceId: workstationGateKey("ws1"),
			target: `https://${g.hostname}/?folder=/home`,
			userId: "u1",
		});
		expect(
			verifyGateToken(WorkstationSignInService.session(g, g.hostname)),
		).toMatchObject({ policyVersion: g.version, userId: "u1" });
	});

	test("any other account, provider or a bad state is refused", async () => {
		const g = await gate();
		restorers.push(
			spyOn(gitProviders.GitProviderService, "exchangeCode").mockResolvedValue({
				accessToken: "t",
				expiresAt: null,
				providerUsername: "mallory",
				refreshToken: null,
			}),
		);
		const state = `ws.${signGateToken(
			{ host: g.hostname, serviceId: workstationGateKey("ws1") },
			60_000,
		)}`;
		await expect(
			WorkstationSignInService.complete("gh", "code", state),
		).rejects.toThrow("Only Alice on GitHub");
		await expect(
			WorkstationSignInService.complete("gitlab", "code", state),
		).rejects.toThrow("doesn't sign in through that git provider");
		await expect(
			WorkstationSignInService.complete("gh", "code", "ws.forged"),
		).rejects.toThrow("expired");
		const serviceState = `ws.${signGateToken(
			{ host: g.hostname, serviceId: "svc" },
			60_000,
		)}`;
		await expect(
			WorkstationSignInService.complete("gh", "code", serviceState),
		).rejects.toThrow("expired");
	});
});

describe("agentHostProblem", () => {
	test("this server and agent hosts are fine, anything else isn't", async () => {
		expect(await agentHostProblem(null)).toBeNull();
		restorers.push(
			spyOn(RemoteHostDTO, "get")
				.mockResolvedValueOnce({ kind: "agent" } as unknown as Host)
				.mockResolvedValueOnce({ kind: "docker" } as unknown as Host)
				.mockResolvedValueOnce(null),
		);
		expect(await agentHostProblem("a")).toBeNull();
		expect(await agentHostProblem("b")).toContain("agent host");
		expect(await agentHostProblem("c")).toContain("agent host");
	});
});
