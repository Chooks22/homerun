import { AuditLogDTO } from "#lib/dto/audit-log-dto.js";

export const load = async () => ({
	entries: (await AuditLogDTO.listRecent()).map((entry) => entry.toJSON()),
});
