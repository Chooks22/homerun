import { intersectPermissions } from "#lib/permissions.js";
import { createServiceAccountApiBody } from "#lib/server/validation/api.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";

export const GET = async ({ locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	return Response.json(await ServiceAccountService.list());
};

export const POST = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = createServiceAccountApiBody.safeParse(
		await request.json().catch(() => null),
	);
	if (!body.success) {
		return Response.json(
			{ error: "Invalid request body", issues: body.error.flatten() },
			{ status: 400 },
		);
	}
	const created = await ServiceAccountService.create(
		body.data.name,
		intersectPermissions(body.data.permissions ?? {}, locals.permissions),
		locals.user.id,
	);
	return Response.json(created, { status: 201 });
};
