import { intersectPermissions } from "#lib/permissions.js";
import { updateServiceAccountApiBody } from "#lib/server/validation/api.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";

export const GET = async ({ params, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const account = await ServiceAccountService.get(params.accountId);
	if (!account) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return Response.json(account);
};

export const PATCH = async ({ params, request, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const body = updateServiceAccountApiBody.safeParse(
		await request.json().catch(() => null),
	);
	if (!body.success) {
		return Response.json(
			{ error: "Invalid request body", issues: body.error.flatten() },
			{ status: 400 },
		);
	}
	const updated = await ServiceAccountService.update(
		params.accountId,
		{
			...body.data,
			permissions: body.data.permissions
				? intersectPermissions(body.data.permissions, locals.permissions)
				: undefined,
		},
		locals.user.id,
	);
	if (!updated) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return Response.json(updated);
};

export const DELETE = async ({ params, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!(await ServiceAccountService.delete(params.accountId, locals.user.id))) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return Response.json({ success: true });
};
