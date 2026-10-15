import { ERROR_PAGE_KINDS, forwardedHost } from "#lib/error-pages.js";
import { ErrorPageService } from "#lib/services/error-page.service.js";

export const GET = async ({ params, request, url }) => {
	const status = Number(params.status);
	const preview = ERROR_PAGE_KINDS.find(
		({ kind }) => kind === url.searchParams.get("preview"),
	)?.kind;
	return await ErrorPageService.respond(
		Number.isInteger(status) && status >= 400 && status <= 599 ? status : 404,
		forwardedHost(request.headers),
		preview ?? null,
		{
			replacedPath: request.headers.get("x-replaced-path"),
			search: url.search,
		},
	);
};

export const fallback = GET;
