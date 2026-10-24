import {
	AcmeDnsError,
	AcmeDnsService,
} from "#lib/services/acme-dns.service.js";

export const POST = async ({ params, request }) => {
	if (!AcmeDnsService.authorized(request.headers.get("authorization"))) {
		return new Response("Unauthorized", { status: 401 });
	}
	const body = (await request.json().catch(() => null)) as {
		fqdn?: unknown;
		value?: unknown;
	} | null;
	if (typeof body?.fqdn !== "string" || typeof body.value !== "string") {
		return new Response("Expected { fqdn, value }", { status: 400 });
	}
	try {
		await AcmeDnsService.handle(params.action, body.fqdn, body.value);
	} catch (error) {
		if (error instanceof AcmeDnsError) {
			return new Response(error.message, { status: error.status });
		}
		throw error;
	}
	return new Response(null, { status: 204 });
};
