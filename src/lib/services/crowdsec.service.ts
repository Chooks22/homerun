import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";

export interface CrowdsecCredentials {
	machineId: string;
	password: string;
	url: string;
}

export interface CrowdsecDecision {
	asName: string | null;
	country: string | null;
	expiresAt: string;
	fromHomerun: boolean;
	id: number;
	origin: string;
	scenario: string;
	type: string;
	value: string;
}

export interface CrowdsecAlert {
	asName: string | null;
	at: string | null;
	country: string | null;
	decisions: number;
	eventsCount: number;
	id: number;
	scenario: string;
	value: string;
}

interface LapiDecision {
	duration: string;
	id: number;
	origin: string;
	scenario: string;
	simulated?: boolean;
	type: string;
	value: string;
}

interface LapiAlert {
	created_at?: string;
	decisions?: LapiDecision[] | null;
	events_count?: number;
	id: number;
	scenario: string;
	source?: { as_name?: string; cn?: string; value?: string };
	start_at?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 500;
const BLOCKLIST_CACHE_MS = 60_000;
const FOREVER = "87600h";
const HOMERUN_SCENARIO_PREFIX = "homerun: ";
const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
const UNIT_MS: Record<string, number> = {
	h: 3_600_000,
	m: 60_000,
	ms: 1,
	ns: 0.000_001,
	s: 1000,
	us: 0.001,
	µs: 0.001,
};

/** A Go duration (`3h59m12.5s`, `-2m`), as the LAPI reports a decision's time left, in milliseconds; null for anything else. */
export function goDurationMs(text: string): number | null {
	const negative = text.startsWith("-");
	const body = negative ? text.slice(1) : text;
	let total = 0;
	let matched = "";
	for (const [part, value, unit] of body.matchAll(DURATION_PART_RE)) {
		total += Number(value) * (UNIT_MS[unit ?? ""] ?? 0);
		matched += part;
	}
	if (!matched || matched !== body) {
		return null;
	}
	return negative ? -total : total;
}

/** The decisions still in force across `alerts` at `now`, simulated ones left out, each once, newest first. */
export function decisionsFrom(
	alerts: LapiAlert[],
	now: Date,
): CrowdsecDecision[] {
	const byId = new Map<number, CrowdsecDecision>();
	for (const alert of alerts) {
		for (const decision of alert.decisions ?? []) {
			const left = goDurationMs(decision.duration);
			if (decision.simulated || left === null || left <= 0) {
				continue;
			}
			byId.set(decision.id, {
				asName: alert.source?.as_name || null,
				country: alert.source?.cn || null,
				expiresAt: new Date(now.getTime() + left).toISOString(),
				fromHomerun: decision.scenario.startsWith(HOMERUN_SCENARIO_PREFIX),
				id: decision.id,
				origin: decision.origin,
				scenario: decision.scenario,
				type: decision.type,
				value: decision.value,
			});
		}
	}
	return [...byId.values()].sort((a, b) => b.id - a.id);
}

/** One LAPI alert as the CrowdSec page lists it. */
export function alertFrom(alert: LapiAlert): CrowdsecAlert {
	return {
		asName: alert.source?.as_name || null,
		at: alert.created_at ?? alert.start_at ?? null,
		country: alert.source?.cn || null,
		decisions: alert.decisions?.length ?? 0,
		eventsCount: alert.events_count ?? 0,
		id: alert.id,
		scenario: alert.scenario,
		value: alert.source?.value ?? "",
	};
}

/**
 * The LAPI alert carrying one ban decision on `ip`, shaped like the one
 * `cscli decisions add` posts so every bouncer honours it. A ban with no
 * end (`durationHours` 0) lasts ten years, since a decision always has a
 * duration.
 */
export function banAlert(params: {
	at: Date;
	durationHours: number;
	ip: string;
	reason: string;
}): Record<string, unknown> {
	const scenario = `${HOMERUN_SCENARIO_PREFIX}${params.reason}`;
	const at = params.at.toISOString();
	return {
		capacity: 0,
		decisions: [
			{
				duration:
					params.durationHours === 0 ? FOREVER : `${params.durationHours}h`,
				origin: "cscli",
				scenario,
				scope: "Ip",
				type: "ban",
				value: params.ip,
			},
		],
		events: [],
		events_count: 1,
		leakspeed: "0",
		message: scenario,
		remediation: true,
		scenario,
		scenario_hash: "",
		scenario_version: "",
		simulated: false,
		source: { ip: params.ip, scope: "Ip", value: params.ip },
		start_at: at,
		stop_at: at,
	};
}

/** Talks to a CrowdSec Local API as a registered machine: pushes IP bans so the bouncers in front of this instance (Pangolin's firewall) drop the address at the edge, and lists, adds and deletes decisions for the CrowdSec page. */
class CrowdsecServiceClass {
	private readonly logger = new Logger("CrowdSec");
	#session: { expiresAt: number; key: string; token: string } | null = null;
	#blocklist: { at: number; decisions: CrowdsecDecision[] } | null = null;

	/**
	 * Logs in to the LAPI as the machine in `credentials` and returns its
	 * token, cached until it expires.
	 *
	 * @throws When the LAPI is unreachable or refuses the machine.
	 */
	async login(credentials: CrowdsecCredentials): Promise<string> {
		const key = JSON.stringify(credentials);
		if (
			this.#session?.key === key &&
			this.#session.expiresAt > Date.now() + 60_000
		) {
			return this.#session.token;
		}
		const response = await fetch(`${credentials.url}/v1/watchers/login`, {
			body: JSON.stringify({
				machine_id: credentials.machineId,
				password: credentials.password,
				scenarios: [],
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`CrowdSec refused the machine login (HTTP ${response.status}).`,
			);
		}
		if (!response.ok) {
			throw new Error(
				`CrowdSec's LAPI at ${credentials.url} didn't answer the login (HTTP ${response.status}): check that it's running and that the URL reaches it directly.`,
			);
		}
		const body = (await response.json()) as { expire?: string; token?: string };
		if (!body.token) {
			throw new Error("CrowdSec's login answer carried no token.");
		}
		this.#session = {
			expiresAt: body.expire ? Date.parse(body.expire) : Date.now() + 600_000,
			key,
			token: body.token,
		};
		return body.token;
	}

	/** Adds a ban decision on `ip` for `durationHours` (0 for good). Does nothing unless CrowdSec is configured; failures are logged, not thrown. */
	async ban(ip: string, durationHours: number, reason: string): Promise<void> {
		await this.#push("ban", () =>
			this.addDecision({ durationHours, ip, reason }),
		);
	}

	/** Deletes every decision on `ip`, CrowdSec's own included. Does nothing unless CrowdSec is configured; failures are logged, not thrown. */
	async unban(ip: string): Promise<void> {
		await this.#push("unban", () =>
			this.#request(`/v1/decisions?${new URLSearchParams({ ip })}`, {
				method: "DELETE",
			}),
		);
	}

	/**
	 * Adds a ban decision on `ip` for `durationHours` (0 for good).
	 *
	 * @throws When CrowdSec isn't configured or the LAPI refuses it.
	 */
	async addDecision(params: {
		durationHours: number;
		ip: string;
		reason: string;
	}): Promise<void> {
		await this.#request("/v1/alerts", {
			body: JSON.stringify([banAlert({ at: new Date(), ...params })]),
			method: "POST",
		});
	}

	/**
	 * Deletes one decision by its LAPI id.
	 *
	 * @throws When CrowdSec isn't configured or the LAPI refuses it.
	 */
	async deleteDecision(id: number): Promise<void> {
		await this.#request(`/v1/decisions/${id}`, { method: "DELETE" });
		this.#blocklist = null;
	}

	/**
	 * One page of the community blocklist's decisions in force, newest first,
	 * narrowed to those whose address or scenario contains `q`. The whole
	 * list is tens of thousands of addresses and megabytes from the LAPI, so
	 * it's read once a minute at most and paged here.
	 *
	 * @throws When CrowdSec isn't configured or the LAPI refuses it.
	 */
	async blocklist(page: { limit: number; offset: number; q: string }): Promise<{
		items: CrowdsecDecision[];
		total: number;
	}> {
		if (
			!this.#blocklist ||
			Date.now() - this.#blocklist.at > BLOCKLIST_CACHE_MS
		) {
			const alerts = (await this.#request(
				`/v1/alerts?${new URLSearchParams({ has_active_decision: "true", limit: String(PAGE_SIZE), origin: "CAPI" })}`,
			)) as LapiAlert[] | null;
			this.#blocklist = {
				at: Date.now(),
				decisions: decisionsFrom(alerts ?? [], new Date()),
			};
		}
		const needle = page.q.trim().toLowerCase();
		const matching = needle
			? this.#blocklist.decisions.filter(
					(decision) =>
						decision.value.includes(needle) ||
						decision.scenario.toLowerCase().includes(needle),
				)
			: this.#blocklist.decisions;
		return {
			items: matching.slice(page.offset, page.offset + page.limit),
			total: matching.length,
		};
	}

	/**
	 * One page of the decisions in force, newest first, read off the alerts
	 * that carry one (a machine can't list decisions directly). The community
	 * blocklist is left out (`include_capi=false`): each of its alerts carries
	 * 15,000 decisions. `total` counts what the newest `PAGE_SIZE` alerts
	 * hold, and `truncated` says the LAPI had more alerts than that.
	 *
	 * @throws When CrowdSec isn't configured or the LAPI refuses it.
	 */
	async activeDecisions(page: { limit: number; offset: number }): Promise<{
		items: CrowdsecDecision[];
		total: number;
		truncated: boolean;
	}> {
		const alerts = (await this.#request(
			`/v1/alerts?${new URLSearchParams({ has_active_decision: "true", include_capi: "false", limit: String(PAGE_SIZE) })}`,
		)) as LapiAlert[] | null;
		const decisions = decisionsFrom(alerts ?? [], new Date());
		return {
			items: decisions.slice(page.offset, page.offset + page.limit),
			total: decisions.length,
			truncated: (alerts ?? []).length >= PAGE_SIZE,
		};
	}

	/**
	 * One page of the last 24 hours' alerts, newest first, the community
	 * blocklist's left out.
	 *
	 * @throws When CrowdSec isn't configured or the LAPI refuses it.
	 */
	async recentAlerts(page: { limit: number; offset: number }): Promise<{
		items: CrowdsecAlert[];
		total: number;
	}> {
		const alerts = (
			((await this.#request(
				`/v1/alerts?${new URLSearchParams({ include_capi: "false", limit: String(PAGE_SIZE), since: "24h" })}`,
			)) as LapiAlert[] | null) ?? []
		)
			.map(alertFrom)
			.sort((a, b) => b.id - a.id);
		return {
			items: alerts.slice(page.offset, page.offset + page.limit),
			total: alerts.length,
		};
	}

	/** Runs `call` when CrowdSec is configured, logging a failure instead of throwing it. */
	async #push(what: string, call: () => Promise<unknown>): Promise<void> {
		if (!(await InstanceSettingsDTO.get()).crowdsecCredentials()) {
			return;
		}
		try {
			await call();
		} catch (err) {
			this.logger.error(`Couldn't push the ${what} to CrowdSec`, err);
		}
	}

	/**
	 * One authenticated LAPI call, logging in again once on a 401, returning
	 * the parsed JSON answer (null for an empty one).
	 *
	 * @throws When CrowdSec isn't configured, unreachable, or answers an error.
	 */
	async #request(path: string, init: RequestInit = {}): Promise<unknown> {
		const credentials = (await InstanceSettingsDTO.get()).crowdsecCredentials();
		if (!credentials) {
			throw new Error("CrowdSec isn't set up under Settings → IP bans.");
		}
		const call = async () =>
			await fetch(`${credentials.url}${path}`, {
				...init,
				headers: {
					authorization: `Bearer ${await this.login(credentials)}`,
					"content-type": "application/json",
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		let response = await call();
		if (response.status === 401) {
			this.#session = null;
			response = await call();
		}
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`CrowdSec answered HTTP ${response.status}: ${text}`);
		}
		return text ? JSON.parse(text) : null;
	}
}

export const CrowdsecService = new CrowdsecServiceClass();
