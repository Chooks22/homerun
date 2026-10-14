import { ServiceAccountService } from "#lib/services/service-account.service.js";

export const DELETE = async ({ params, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const revoked = await ServiceAccountService.revokeKey(
		params.accountId,
		params.keyId,
		locals.user.id,
	);
	if (!revoked) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	return Response.json({ success: true });
};
