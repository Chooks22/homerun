import { serviceDomain } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { ServiceDTO } from "#lib/dto/service-dto.js";
import { StackDTO } from "#lib/dto/stack-dto.js";
import {
	ERROR_PAGE_HEADER,
	type ErrorPageKind,
	errorPageKind,
	renderErrorPage,
} from "#lib/error-pages.js";
import { domainHosts, serviceHostnames } from "#lib/service-domains.js";

/**
 * Serves the branded pages Traefik shows instead of its own errors: the
 * catch-all router's 404 for a host no router claims, and the `errors`
 * middleware's 502, 503 and 504 for a service whose container can't answer.
 */
class ErrorPageServiceClass {
	/**
	 * The error page for `status` as a response with that status, for the
	 * request's original host. A 404 on a host one of the services routes
	 * says the app is on its way rather than that nothing lives there.
	 * `preview` forces a page, for the settings tab's preview links. Every
	 * page carries `ERROR_PAGE_HEADER`, so a deploy's route check tells
	 * Traefik's answer apart from the app's own.
	 */
	async respond(
		status: number,
		host: string | null,
		preview: ErrorPageKind | null = null,
	): Promise<Response> {
		const settings = (await InstanceSettingsDTO.get()).errorPages;
		const known =
			!preview && status === 404 && host
				? await this.#hostBelongsToService(host)
				: false;
		return new Response(
			renderErrorPage(
				settings,
				preview ?? errorPageKind(status, known),
				status,
			),
			{
				headers: {
					"Cache-Control": "no-store",
					"Content-Type": "text/html; charset=utf-8",
					[ERROR_PAGE_HEADER]: String(status),
				},
				status,
			},
		);
	}

	/** Whether any service, deployed or not, routes `host`. */
	async #hostBelongsToService(host: string): Promise<boolean> {
		const [services, stacks] = await Promise.all([
			ServiceDTO.list(),
			StackDTO.list(),
		]);
		const stackSlugs = new Map(stacks.map((stack) => [stack.id, stack.slug]));
		return services.some((entry) => {
			const row = entry.toJSON();
			return domainHosts(
				serviceHostnames(
					row,
					row.stackId ? stackSlugs.get(row.stackId) : null,
					serviceDomain(),
				),
			).includes(host);
		});
	}
}

export const ErrorPageService = new ErrorPageServiceClass();
