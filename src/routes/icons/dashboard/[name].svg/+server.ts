import { createHash } from "node:crypto";
import { DashboardIconsService } from "#lib/services/dashboard-icons.service.js";

const LOCKDOWN = {
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; sandbox",
	"X-Content-Type-Options": "nosniff",
};

export const GET = async ({ params, request, url }) => {
	const theme = url.searchParams.get("theme");
	const icon = await DashboardIconsService.icon(
		params.name,
		theme === "dark" || theme === "light" ? theme : null,
	);
	if (!icon) {
		return new Response("Unknown icon", {
			headers: {
				...LOCKDOWN,
				"Cache-Control": "public, max-age=600",
				"Content-Type": "text/plain; charset=utf-8",
			},
			status: 404,
		});
	}
	const etag = `"${createHash("sha1").update(icon.body).digest("hex")}"`;
	const headers = {
		...LOCKDOWN,
		"Cache-Control": "public, max-age=2592000",
		ETag: etag,
	};
	if (request.headers.get("if-none-match") === etag) {
		return new Response(null, { headers, status: 304 });
	}
	return new Response(icon.body, {
		headers: {
			...headers,
			"Content-Length": String(icon.body.byteLength),
			"Content-Type": icon.contentType,
		},
	});
};
