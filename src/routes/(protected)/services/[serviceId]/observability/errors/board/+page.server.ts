import { ErrorIssueDTO } from "#lib/dto/error-issue-dto.js";
import { ErrorProjectDTO } from "#lib/dto/error-project-dto.js";
import { ISSUE_STATUSES } from "#lib/error-tracking/event.js";
import { changeIssueStatus } from "#lib/server/error-issue-status.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";

const COLUMN_SIZE = 50;

export const load = async ({ parent, url }) => {
	const { service } = await parent();
	if (service.previewParentId) {
		return { columns: null, parentId: service.previewParentId };
	}
	if (!(await ErrorProjectDTO.getForService(service.id))) {
		return { columns: null, parentId: null };
	}
	const query = parseListQuery(url, {
		perPage: COLUMN_SIZE,
		sortKeys: ["lastSeen", "firstSeen", "count"],
	});
	const columns = await Promise.all(
		ISSUE_STATUSES.map(async (status) => {
			const page = await ErrorIssueDTO.listPaged(service.id, {
				...query,
				filters: { status: [status] },
				limit: COLUMN_SIZE,
				offset: 0,
				page: 1,
			});
			return { items: page.items, status, total: page.total };
		}),
	);
	return { columns, parentId: null };
};

export const actions = {
	status: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await changeIssueStatus(
			params.serviceId,
			await request.formData(),
			locals.user.id,
		);
	},
};
