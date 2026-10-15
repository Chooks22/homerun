import { serviceDomain } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import {
	ERROR_PAGE_HEADER,
	type ErrorPageKind,
	type ErrorPagesSettings,
	errorPageKind,
	renderErrorPage,
} from "#lib/error-pages.js";
import { wakeRedirectTarget } from "#lib/scale-to-zero.js";
import { domainHosts, serviceHostnames } from "#lib/service-domains.js";
import {
	ScaleToZeroService,
	WAKE_GRACE_MS,
} from "#lib/services/scale-to-zero.service.js";

const WAKE_HOLD_MS = 25_000;

/** The parts of the request Traefik sent to the error pages that a wake needs. */
export interface ErrorPageRequest {
	replacedPath: string | null;
	search: string;
}

/**
 * Serves the branded pages Traefik shows instead of its own errors: the
 * catch-all router's 404 for a host no router claims, and the `errors`
 * middleware's 502, 503 and 504 for a service whose container can't answer.
 * A request for a service scale to zero put to sleep wakes it here.
 */
class ErrorPageServiceClass {
	/**
	 * The error page for `status` as a response with that status, for the
	 * request's original host. A 404 on a host one of the services routes
	 * says the app is on its way rather than that nothing lives there; one
	 * on a sleeping service's host wakes it (see `#wakeResponse`). `preview`
	 * forces a page, for the settings tab's preview links. Every page carries
	 * `ERROR_PAGE_HEADER`, so a deploy's route check tells Traefik's answer
	 * apart from the app's own.
	 */
	async respond(
		status: number,
		host: string | null,
		preview: ErrorPageKind | null = null,
		request: ErrorPageRequest | null = null,
	): Promise<Response> {
		const settings = (await InstanceSettingsDTO.get()).errorPages;
		const owner =
			!preview && host && (status === 404 || status >= 502)
				? await this.#serviceForHost(host)
				: null;
		const waking = owner
			? await this.#wakeResponse(owner, status, request, settings)
			: null;
		if (waking) {
			return waking;
		}
		return this.#page(
			settings,
			preview ?? errorPageKind(status, status === 404 && owner !== null),
			status,
		);
	}

	/**
	 * The answer for a request to a scale to zero service, or null when it's
	 * neither asleep nor waking. The request that finds it asleep, and any
	 * other while that wake is under way, is held until the service is up (at
	 * most `WAKE_HOLD_MS`) and sent back to the same URL with a 307, which
	 * keeps its method and body. A request that can't be sent back (the
	 * `errors` middleware doesn't pass the original path) or that outlasts the
	 * hold gets the self-reloading "waking up" page, as does one that lands
	 * here right after a wake, while Traefik catches up.
	 */
	async #wakeResponse(
		svc: ServiceDTO,
		status: number,
		request: ErrorPageRequest | null,
		settings: ErrorPagesSettings,
	): Promise<Response | null> {
		const { scaleToZeroMinutes, sleepingSince, wokenAt } = svc.toJSON();
		if (!scaleToZeroMinutes) {
			return null;
		}
		const asleep =
			sleepingSince !== null || ScaleToZeroService.isWaking(svc.id);
		const justWoken =
			wokenAt !== null && Date.now() - wokenAt.getTime() < WAKE_GRACE_MS;
		if (!(asleep || justWoken)) {
			return null;
		}
		const target =
			asleep && status === 404 && request
				? wakeRedirectTarget(request.replacedPath, request.search)
				: null;
		if (asleep) {
			const wake = ScaleToZeroService.wake(svc);
			if (target) {
				const ready = await Promise.race([
					wake,
					Bun.sleep(WAKE_HOLD_MS).then(() => false),
				]);
				if (ready) {
					return new Response(null, {
						headers: {
							"Cache-Control": "no-store",
							Location: target,
							[ERROR_PAGE_HEADER]: "307",
						},
						status: 307,
					});
				}
			}
		}
		return this.#page(settings, "waking", 503, { "Retry-After": "2" });
	}

	/** One error page as a response. */
	#page(
		settings: ErrorPagesSettings,
		kind: ErrorPageKind,
		status: number,
		headers: Record<string, string> = {},
	): Response {
		return new Response(renderErrorPage(settings, kind, status), {
			headers: {
				"Cache-Control": "no-store",
				"Content-Type": "text/html; charset=utf-8",
				[ERROR_PAGE_HEADER]: String(status),
				...headers,
			},
			status,
		});
	}

	/** The service, deployed or not, that routes `host`, or null when none does. */
	async #serviceForHost(host: string): Promise<ServiceDTO | null> {
		const [services, stacks] = await Promise.all([
			ServiceDTO.list(),
			StackDTO.list(),
		]);
		const stackSlugs = new Map(stacks.map((stack) => [stack.id, stack.slug]));
		return (
			services.find((entry) => {
				const row = entry.toJSON();
				return domainHosts(
					serviceHostnames(
						row,
						row.stackId ? stackSlugs.get(row.stackId) : null,
						serviceDomain(),
					),
				).includes(host);
			}) ?? null
		);
	}
}

export const ErrorPageService = new ErrorPageServiceClass();
