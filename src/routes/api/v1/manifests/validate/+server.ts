import { manifestFromRequest } from "#lib/server/manifest.js";

export const POST = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = await manifestFromRequest(request);
	return Response.json(
		"errors" in parsed
			? { errors: parsed.errors, valid: false }
			: { errors: [], valid: true },
	);
};
