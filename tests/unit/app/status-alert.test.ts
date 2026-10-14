import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	AlertDamper,
	DOWN_CONFIRM_FAILURES,
	detectTransitions,
	RECOVERY_STABLE_MS,
	StatusAlertService,
} = await import("../../../src/lib/services/status-alert.service");
const { NotificationChannelService } = await import(
	"../../../src/lib/services/notification-channel.service"
);
const { config } = await import("../../../src/lib/config");
const { Logger } = await import("../../../src/lib/logger");

function prior(entries: Array<[string, boolean]>) {
	return new Map(entries.map(([key, ok]) => [key, { ok }]));
}

describe("AlertDamper", () => {
	const probe = (ok: boolean) => ({
		detail: ok ? "HTTP 200" : "HTTP 504",
		kind: "external" as const,
		ok,
		serviceId: "umami",
	});
	const minute = 60_000;

	test("one failed check that recovers on the next one sends nothing", () => {
		const damper = new AlertDamper();
		expect(damper.alerts([probe(false)], [probe(false)], 0)).toEqual([]);
		expect(damper.alerts([probe(true)], [probe(true)], minute)).toEqual([]);
		expect(
			damper.alerts([], [probe(true)], minute + RECOVERY_STABLE_MS),
		).toEqual([]);
	});

	test("a probe alerts down once it has failed enough checks in a row", () => {
		const damper = new AlertDamper();
		const ticks = Array.from({ length: DOWN_CONFIRM_FAILURES }, (_, tick) =>
			damper.alerts(
				tick === 0 ? [probe(false)] : [],
				[probe(false)],
				tick * minute,
			),
		);
		expect(ticks.slice(0, -1).flat()).toEqual([]);
		expect(ticks.at(-1)).toEqual([probe(false)]);
		expect(
			damper.alerts([], [probe(false)], DOWN_CONFIRM_FAILURES * minute),
		).toEqual([]);
	});

	test("a flapping service alerts down once, and recovered only after staying up", () => {
		const damper = new AlertDamper();
		damper.alerts([probe(false)], [probe(false)], 0);
		damper.alerts([], [probe(false)], minute);
		expect(damper.alerts([], [probe(false)], 2 * minute)).toEqual([
			probe(false),
		]);

		expect(damper.alerts([probe(true)], [probe(true)], 5 * minute)).toEqual([]);
		expect(damper.alerts([probe(false)], [probe(false)], 12 * minute)).toEqual(
			[],
		);
		expect(damper.alerts([probe(true)], [probe(true)], 20 * minute)).toEqual(
			[],
		);
		expect(damper.alerts([], [probe(true)], 30 * minute)).toEqual([]);
		expect(
			damper.alerts([], [probe(true)], 20 * minute + RECOVERY_STABLE_MS),
		).toEqual([probe(true)]);
	});

	test("a recovery seen with no down on record still waits to be stable", () => {
		const damper = new AlertDamper();
		expect(damper.alerts([probe(true)], [probe(true)], 0)).toEqual([]);
		expect(damper.alerts([], [probe(true)], RECOVERY_STABLE_MS)).toEqual([
			probe(true),
		]);
	});
});

describe("detectTransitions", () => {
	test("reports a probe that went from up to down, and back", () => {
		const previous = prior([
			["a:internal", true],
			["b:external", false],
		]);

		expect(
			detectTransitions(previous, [
				{
					detail: "Connection refused.",
					kind: "internal",
					ok: false,
					serviceId: "a",
				},
				{ detail: "HTTP 200", kind: "external", ok: true, serviceId: "b" },
			]),
		).toEqual([
			{
				detail: "Connection refused.",
				kind: "internal",
				ok: false,
				serviceId: "a",
			},
			{ detail: "HTTP 200", kind: "external", ok: true, serviceId: "b" },
		]);
	});

	test("a probe holding the same state is not a transition", () => {
		const previous = prior([
			["a:internal", true],
			["b:internal", false],
		]);

		expect(
			detectTransitions(previous, [
				{ kind: "internal", ok: true, serviceId: "a" },
				{ kind: "internal", ok: false, serviceId: "b" },
			]),
		).toEqual([]);
	});

	test("a first-ever beat is not a transition", () => {
		expect(
			detectTransitions(new Map(), [
				{ kind: "internal", ok: false, serviceId: "fresh" },
			]),
		).toEqual([]);
	});

	test("the two probes of one service are tracked separately", () => {
		const previous = prior([
			["a:internal", true],
			["a:external", true],
		]);

		expect(
			detectTransitions(previous, [
				{ kind: "internal", ok: true, serviceId: "a" },
				{ kind: "external", ok: false, serviceId: "a" },
			]),
		).toEqual([{ detail: null, kind: "external", ok: false, serviceId: "a" }]);
	});
});

describe("StatusAlertService.dispatch", () => {
	type Services = Parameters<typeof StatusAlertService.dispatch>[1];
	const originalOrigin = config.auth.origin;
	const dispatched: Array<Record<string, unknown>> = [];
	const logged: string[] = [];

	function services(entries: Array<[string, string, string | null]>): Services {
		return new Map(
			entries.map(([id, name, host]) => [id, { host, svc: { id, name } }]),
		) as unknown as Services;
	}

	beforeEach(() => {
		dispatched.length = 0;
		logged.length = 0;
		config.auth.origin = "https://homerun.example.com/";
		stub(
			NotificationChannelService,
			"dispatch",
			async (message: Record<string, unknown>) => {
				if (message.serviceId === "flaky") {
					throw new Error("webhook timed out");
				}
				dispatched.push(message);
			},
		);
		stub(Logger.prototype, "error", (message: string) => {
			logged.push(message);
		});
	});

	afterEach(() => {
		config.auth.origin = originalOrigin;
		restoreStubs();
	});

	test("sends a down and a recovery message per transition with the dashboard link", async () => {
		await StatusAlertService.dispatch(
			[
				{
					detail: "HTTP 502",
					kind: "external",
					ok: false,
					serviceId: "web",
				},
				{ detail: null, kind: "internal", ok: true, serviceId: "db" },
			],
			services([
				["web", "Web", "web.example.com"],
				["db", "Postgres", null],
			]),
		);

		expect(dispatched).toHaveLength(2);
		const [down, up] = dispatched;
		expect(down).toMatchObject({
			detail: "HTTP 502",
			event: "service.down",
			fields: [
				{ name: "Probe", value: "External (public URL)" },
				{ name: "Host", value: "web.example.com" },
			],
			link: "https://homerun.example.com/services/web/observability/events",
			serviceId: "web",
			serviceName: "Web",
			title: "Web is down",
		});
		expect(up).toMatchObject({
			event: "service.up",
			fields: [{ name: "Probe", value: "Internal (Docker network)" }],
			title: "Postgres recovered",
		});
		expect(Number.isNaN(Date.parse(String(down?.timestamp)))).toBe(false);
	});

	test("skips a transition for a service that's no longer known", async () => {
		await StatusAlertService.dispatch(
			[{ detail: null, kind: "internal", ok: false, serviceId: "deleted" }],
			services([]),
		);

		expect(dispatched).toEqual([]);
	});

	test("a failed dispatch is logged and doesn't stop the others", async () => {
		config.auth.origin = undefined;

		await StatusAlertService.dispatch(
			[
				{ detail: null, kind: "internal", ok: false, serviceId: "flaky" },
				{ detail: null, kind: "internal", ok: false, serviceId: "web" },
			],
			services([
				["flaky", "Flaky", null],
				["web", "Web", null],
			]),
		);

		expect(dispatched.map((message) => message.serviceId)).toEqual(["web"]);
		expect(dispatched[0]?.link).toBeNull();
		expect(logged).toEqual([
			"Alert dispatch failed: service=flaky : webhook timed out",
		]);
	});
});
