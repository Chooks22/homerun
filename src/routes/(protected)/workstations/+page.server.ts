import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { workstationAction } from "#lib/server/workstation-actions.js";

export const load = async ({ parent, url }) => {
	const { preferences, user } = await parent();
	const query = parseListQuery(
		url,
		{ filterKeys: ["state"], sortKeys: sortKeysOf(BASE_SORTS) },
		preferences.perPage,
	);
	const paged = await WorkstationDTO.listPaged(user.id, query);
	return {
		filtered: query.active,
		page: paged.page,
		perPage: paged.perPage,
		total: paged.total,
		workstations: paged.items.map((ws) => ws.toPublic()),
	};
};

export const actions = {
	start: ({ locals, request }) => workstationAction(locals, request, "start"),
	stop: ({ locals, request }) => workstationAction(locals, request, "stop"),
};
