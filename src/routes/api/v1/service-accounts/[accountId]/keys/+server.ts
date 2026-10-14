import { createServiceAccountKeyApiBody } from "#lib/server/validation/api.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";

const DEFAULT_EXPIRY_DAYS = 90;

export const GET = async ({ params, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!(await ServiceAccountService.get(params.accountId))) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return Response.json(await ServiceAccountService.listKeys(params.accountId));
};

export const POST = async ({ params, request, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = createServiceAccountKeyApiBody.safeParse(
		await request.json().catch(() => ({})),
	);
	if (!body.success) {
		return Response.json(
			{ error: "Invalid request body", issues: body.error.flatten() },
			{ status: 400 },
		);
	}
	const created = await ServiceAccountService.createKey(
		params.accountId,
		body.data.name ?? "Service account key",
		body.data.expiresInDays === undefined
			? DEFAULT_EXPIRY_DAYS
			: body.data.expiresInDays,
		locals.user.id,
	);
	if (!created) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return Response.json(created, { status: 201 });
};
