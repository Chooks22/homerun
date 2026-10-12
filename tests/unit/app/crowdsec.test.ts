import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { alertFrom, banAlert, CrowdsecService, decisionsFrom, goDurationMs } =
	await import("../../../src/lib/services/crowdsec.service");
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);

const credentials = {
	machineId: "homerun",
	password: "secret",
	url: "https://lapi.example.org",
};

function settingsWith(value: typeof credentials | null) {
	return spyOn(InstanceSettingsDTO, "get").mockResolvedValue({
		crowdsecCredentials: () => value,
	} as unknown as Awaited<ReturnType<typeof InstanceSettingsDTO.get>>);
}

function lapi(handler: (url: string, init: RequestInit) => Response) {
	const calls: { init: RequestInit; url: string }[] = [];
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		calls.push({ init: init ?? {}, url });
		return handler(url, init ?? {});
	}) as typeof fetch);
	return { calls, fetchSpy };
}

const loggedIn = (token: string) =>
	Response.json({
		code: 200,
		expire: new Date(Date.now() + 3_600_000).toISOString(),
		token,
	});

describe("CrowdSec ban alert", () => {
	const at = new Date("2026-10-11T12:00:00Z");

	test("carries one IP-scoped ban decision for the ban's length", () => {
		const alert = banAlert({
			at,
			durationHours: 24,
			ip: "203.0.113.9",
			reason: "10 blocked requests in 10 min",
		});
		expect(alert.decisions).toEqual([
			{
				duration: "24h",
				origin: "cscli",
				scenario: "homerun: 10 blocked requests in 10 min",
				scope: "Ip",
				type: "ban",
				value: "203.0.113.9",
			},
		]);
		expect(alert.source).toEqual({
			ip: "203.0.113.9",
			scope: "Ip",
			value: "203.0.113.9",
		});
		expect(alert.start_at).toBe("2026-10-11T12:00:00.000Z");
	});

	test("a ban for good lasts ten years", () => {
		const alert = banAlert({
			at,
			durationHours: 0,
			ip: "203.0.113.9",
			reason: "x",
		});
		expect((alert.decisions as { duration: string }[])[0]?.duration).toBe(
			"87600h",
		);
	});
});

describe("CrowdSec LAPI calls", () => {
	afterEach(() => {
		mock.restore();
	});

	test("login posts the machine and caches the token per credentials", async () => {
		const { calls } = lapi(() => loggedIn("t1"));
		const fresh = { ...credentials, machineId: "login-cache" };
		expect(await CrowdsecService.login(fresh)).toBe("t1");
		expect(await CrowdsecService.login(fresh)).toBe("t1");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://lapi.example.org/v1/watchers/login");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			machine_id: "login-cache",
			password: "secret",
			scenarios: [],
		});
	});

	test("login throws on a refusal or an answer without a token", async () => {
		lapi(() => new Response("no", { status: 403 }));
		await expect(
			CrowdsecService.login({ ...credentials, machineId: "refused" }),
		).rejects.toThrow("HTTP 403");
		mock.restore();
		lapi(() => Response.json({ code: 200 }));
		await expect(
			CrowdsecService.login({ ...credentials, machineId: "tokenless" }),
		).rejects.toThrow("no token");
	});

	test("ban posts one alert with the bearer token", async () => {
		settingsWith({ ...credentials, machineId: "ban" });
		const { calls } = lapi((url) =>
			url.endsWith("/login") ? loggedIn("t2") : Response.json(["1"]),
		);
		await CrowdsecService.ban("203.0.113.9", 24, "10 blocked requests");
		const post = calls.find((call) => call.url.endsWith("/v1/alerts"));
		expect(post?.init.method).toBe("POST");
		expect(post?.init.headers).toMatchObject({ authorization: "Bearer t2" });
		const [alert] = JSON.parse(String(post?.init.body));
		expect(alert.decisions[0].value).toBe("203.0.113.9");
	});

	test("unban deletes the address's decisions, logging in again after a 401", async () => {
		settingsWith({ ...credentials, machineId: "unban" });
		let deletes = 0;
		const { calls } = lapi((url) => {
			if (url.endsWith("/login")) {
				return loggedIn("t3");
			}
			deletes += 1;
			return deletes === 1
				? new Response("expired", { status: 401 })
				: Response.json({ nbDeleted: "1" });
		});
		await CrowdsecService.unban("203.0.113.9");
		expect(calls.filter((call) => call.url.endsWith("/login"))).toHaveLength(2);
		expect(calls.at(-1)?.url).toBe(
			"https://lapi.example.org/v1/decisions?ip=203.0.113.9",
		);
		expect(calls.at(-1)?.init.method).toBe("DELETE");
	});

	test("a failed push is logged, not thrown", async () => {
		settingsWith({ ...credentials, machineId: "failing" });
		lapi((url) =>
			url.endsWith("/login")
				? loggedIn("t4")
				: new Response("boom", { status: 500 }),
		);
		await expect(
			CrowdsecService.ban("203.0.113.9", 0, "x"),
		).resolves.toBeUndefined();
	});

	test("does nothing unless CrowdSec is configured", async () => {
		settingsWith(null);
		const { fetchSpy } = lapi(() => loggedIn("never"));
		await CrowdsecService.ban("203.0.113.9", 24, "x");
		await CrowdsecService.unban("203.0.113.9");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("LAPI durations", () => {
	test("parse Go durations, negative included", () => {
		expect(goDurationMs("3h59m12.5s")).toBe(14_352_500);
		expect(goDurationMs("1m30s")).toBe(90_000);
		expect(goDurationMs("250ms")).toBe(250);
		expect(goDurationMs("-2m")).toBe(-120_000);
		expect(goDurationMs("soon")).toBeNull();
		expect(goDurationMs("5m garbage")).toBeNull();
		expect(goDurationMs("")).toBeNull();
	});
});

describe("decisions and alerts from LAPI alerts", () => {
	const now = new Date("2026-10-12T00:00:00Z");
	const alert = {
		created_at: "2026-10-11T23:00:00Z",
		decisions: [
			{
				duration: "1h",
				id: 7,
				origin: "cscli",
				scenario: "homerun: 10 blocked requests",
				type: "ban",
				value: "203.0.113.9",
			},
			{
				duration: "-1m",
				id: 6,
				origin: "crowdsec",
				scenario: "crowdsecurity/http-probing",
				type: "ban",
				value: "203.0.113.9",
			},
			{
				duration: "1h",
				id: 5,
				origin: "crowdsec",
				scenario: "crowdsecurity/http-probing",
				simulated: true,
				type: "ban",
				value: "203.0.113.9",
			},
		],
		events_count: 10,
		id: 3,
		scenario: "homerun: 10 blocked requests",
		source: { as_name: "Example AS", cn: "FR", value: "203.0.113.9" },
	};

	test("keep only the ones in force, newest first", () => {
		const second = {
			...alert,
			decisions: [
				{ ...alert.decisions[0], id: 9, scenario: "crowdsecurity/ssh-bf" },
			],
			id: 4,
			source: {},
		};
		const decisions = decisionsFrom(
			[alert, second] as Parameters<typeof decisionsFrom>[0],
			now,
		);
		expect(decisions.map((decision) => decision.id)).toEqual([9, 7]);
		expect(decisions[1]).toEqual({
			asName: "Example AS",
			country: "FR",
			expiresAt: "2026-10-12T01:00:00.000Z",
			fromHomerun: true,
			id: 7,
			origin: "cscli",
			scenario: "homerun: 10 blocked requests",
			type: "ban",
			value: "203.0.113.9",
		});
		expect(decisions[0]?.fromHomerun).toBe(false);
		expect(decisions[0]?.country).toBeNull();
	});

	test("an alert keeps its source, counts and time", () => {
		expect(alertFrom(alert as Parameters<typeof alertFrom>[0])).toEqual({
			asName: "Example AS",
			at: "2026-10-11T23:00:00Z",
			country: "FR",
			decisions: 3,
			eventsCount: 10,
			id: 3,
			scenario: "homerun: 10 blocked requests",
			value: "203.0.113.9",
		});
		expect(
			alertFrom({ id: 1, scenario: "x" } as Parameters<typeof alertFrom>[0]),
		).toEqual({
			asName: null,
			at: null,
			country: null,
			decisions: 0,
			eventsCount: 0,
			id: 1,
			scenario: "x",
			value: "",
		});
	});
});

describe("CrowdSec page calls", () => {
	afterEach(() => {
		mock.restore();
	});

	test("active decisions come from alerts with one in force", async () => {
		settingsWith({ ...credentials, machineId: "list" });
		const { calls } = lapi((url) =>
			url.endsWith("/login")
				? loggedIn("t5")
				: Response.json([
						{
							decisions: [
								{
									duration: "2h",
									id: 1,
									origin: "crowdsec",
									scenario: "crowdsecurity/http-probing",
									type: "ban",
									value: "198.51.100.7",
								},
							],
							id: 1,
							scenario: "crowdsecurity/http-probing",
						},
					]),
		);
		const result = await CrowdsecService.activeDecisions();
		expect(result.truncated).toBe(false);
		expect(result.decisions.map((decision) => decision.value)).toEqual([
			"198.51.100.7",
		]);
		expect(calls.at(-1)?.url).toBe(
			"https://lapi.example.org/v1/alerts?has_active_decision=true&limit=500",
		);
	});

	test("an empty answer is no decision and no alert", async () => {
		settingsWith({ ...credentials, machineId: "empty" });
		lapi((url) =>
			url.endsWith("/login") ? loggedIn("t6") : new Response("null"),
		);
		expect(await CrowdsecService.activeDecisions()).toEqual({
			decisions: [],
			truncated: false,
		});
		expect(await CrowdsecService.recentAlerts()).toEqual([]);
	});

	test("recent alerts are the last day's, newest first", async () => {
		settingsWith({ ...credentials, machineId: "alerts" });
		const { calls } = lapi((url) =>
			url.endsWith("/login")
				? loggedIn("t7")
				: Response.json([
						{ id: 1, scenario: "a" },
						{ id: 2, scenario: "b" },
					]),
		);
		const alerts = await CrowdsecService.recentAlerts();
		expect(alerts.map((entry) => entry.id)).toEqual([2, 1]);
		expect(calls.at(-1)?.url).toBe(
			"https://lapi.example.org/v1/alerts?limit=100&since=24h",
		);
	});

	test("deleting a decision targets its id and surfaces a refusal", async () => {
		settingsWith({ ...credentials, machineId: "delete" });
		const { calls } = lapi((url) => {
			if (url.endsWith("/login")) {
				return loggedIn("t8");
			}
			return url.endsWith("/v1/decisions/42")
				? Response.json({ nbDeleted: "1" })
				: new Response("not found", { status: 404 });
		});
		await CrowdsecService.deleteDecision(42);
		expect(calls.at(-1)?.init.method).toBe("DELETE");
		await expect(CrowdsecService.deleteDecision(43)).rejects.toThrow(
			"HTTP 404",
		);
	});

	test("the page calls refuse when CrowdSec isn't set up", async () => {
		settingsWith(null);
		await expect(CrowdsecService.recentAlerts()).rejects.toThrow(
			"isn't set up",
		);
		await expect(
			CrowdsecService.addDecision({ durationHours: 1, ip: "x", reason: "y" }),
		).rejects.toThrow("isn't set up");
	});
});
