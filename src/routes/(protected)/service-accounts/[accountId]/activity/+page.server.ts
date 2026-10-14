import { AuditLogDTO } from "#lib/dto/audit-log-dto.js";

export const load = async ({ params }) => ({
	entries: (await AuditLogDTO.listForActor(params.accountId)).map((entry) =>
		entry.toJSON(),
	),
});
