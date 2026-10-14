import { AuditLogDTO } from "#lib/dto/audit-log-dto.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";

export const GET = async ({ params, locals }) => {
	if (!locals.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!(await ServiceAccountService.get(params.accountId))) {
		return Response.json({ error: "Not found" }, { status: 404 });
	}
	const entries = await AuditLogDTO.listForActor(params.accountId);
	return Response.json(entries.map((entry) => entry.toJSON()));
};
