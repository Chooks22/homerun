import { config } from "#lib/config.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import type { ProbeResult } from "#lib/dto/uptime-check-dto.js";
import { Logger } from "#lib/logger.js";
import type { UptimeCheck } from "#lib/server/db/schema.js";
import { NotificationChannelService } from "./notification-channel.service";
import { uptimeMessage } from "./notification-messages";

const logger = new Logger("StatusAlerts");

export interface ProbeTransition {
	detail: string | null;
	kind: "internal" | "external";
	ok: boolean;
	serviceId: string;
}

/** Diffs a fresh batch of probe results against each check's previous `ok` state, returning only the ones whose state actually flipped (a new check with no prior state is not a transition). */
export function detectTransitions(
	previous: Map<string, Pick<UptimeCheck, "ok">>,
	results: ProbeResult[],
): ProbeTransition[] {
	const transitions: ProbeTransition[] = [];
	for (const result of results) {
		const prior = previous.get(`${result.serviceId}:${result.kind}`);
		if (prior === undefined || prior.ok === result.ok) {
			continue;
		}
		transitions.push({
			detail: result.detail ?? null,
			kind: result.kind,
			ok: result.ok,
			serviceId: result.serviceId,
		});
	}
	return transitions;
}

export const RECOVERY_STABLE_MS = 15 * 60_000;

export const DOWN_CONFIRM_FAILURES = 3;

interface ProbeAlertState {
	alerted: boolean;
	failures: number;
	upSince: number | null;
}

/**
 * Turns raw probe transitions into the alerts worth sending. A probe that
 * goes down alerts only once it has failed `DOWN_CONFIRM_FAILURES` checks in
 * a row, so a dropped connection or a slow answer on one tick is never an
 * outage, and a blip that recovers before then sends nothing at all. A
 * service that flaps alerts down once: its recovery alerts only after it
 * stays up for `RECOVERY_STABLE_MS`, and failing again before then is silent,
 * since the down alert still stands. A recovery with no down on record (the
 * process restarted after alerting) also waits to be stable. State lives in
 * memory: a restart forgets it, which at worst sends one extra alert.
 */
export class AlertDamper {
	readonly #states = new Map<string, ProbeAlertState>();

	/** The alerts to dispatch for this tick's `transitions`, given every result of the tick and the current time. */
	alerts(
		transitions: ProbeTransition[],
		results: ProbeResult[],
		now: number,
	): ProbeTransition[] {
		const flips = new Map(
			transitions.map((transition) => [
				`${transition.serviceId}:${transition.kind}`,
				transition,
			]),
		);
		const alerts: ProbeTransition[] = [];
		for (const result of results) {
			const key = `${result.serviceId}:${result.kind}`;
			const flip = flips.get(key);
			let state = this.#states.get(key);
			if (flip && !state) {
				state = { alerted: flip.ok, failures: 0, upSince: null };
				this.#states.set(key, state);
			}
			if (!state) {
				continue;
			}
			const alert = {
				detail: result.detail ?? null,
				kind: result.kind,
				ok: result.ok,
				serviceId: result.serviceId,
			};
			if (!result.ok) {
				state.failures += 1;
				state.upSince = null;
				if (!state.alerted && state.failures >= DOWN_CONFIRM_FAILURES) {
					state.alerted = true;
					alerts.push(alert);
				}
				continue;
			}
			if (!state.alerted) {
				this.#states.delete(key);
				continue;
			}
			state.failures = 0;
			state.upSince ??= now;
			if (now - state.upSince >= RECOVERY_STABLE_MS) {
				this.#states.delete(key);
				alerts.push(alert);
			}
		}
		return alerts;
	}
}

class StatusAlertServiceClass {
	/** Sends an uptime notification for each transition to every account's channels via `NotificationChannelService`. Per-transition failures are logged and don't stop the others from dispatching. */
	async dispatch(
		transitions: ProbeTransition[],
		servicesById: Map<string, { host: string | null; svc: ServiceDTO }>,
	): Promise<void> {
		await Promise.all(
			transitions.map(async (transition) => {
				const entry = servicesById.get(transition.serviceId);
				if (!entry) {
					return;
				}
				const { host, svc } = entry;
				try {
					await NotificationChannelService.dispatch(
						uptimeMessage(
							{
								detail: transition.detail,
								kind: transition.kind,
								ok: transition.ok,
								origin: config.auth.origin ?? null,
								publicHost: host,
								service: { id: svc.id, name: svc.name },
							},
							new Date().toISOString(),
						),
					);
				} catch (err) {
					logger.error(
						`Alert dispatch failed: service=${transition.serviceId} : ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}),
		);
	}
}

export const StatusAlertService = new StatusAlertServiceClass();
