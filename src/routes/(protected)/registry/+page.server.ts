import { fail } from "@sveltejs/kit";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { DashboardIconsService } from "#lib/services/dashboard-icons.service.js";
import { enqueueCleanup } from "#lib/services/docker-cleanup-queue.js";
import { ImageMirrorGcService } from "#lib/services/image-mirror-gc.service.js";
import { RegistryService } from "#lib/services/registry.service.js";

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(url, {}, preferences.perPage);
	const listing = RegistryService.catalogPage(query)
		.then(async (result) => ({
			...result,
			items: await Promise.all(
				result.items.map(async (item) => ({
					...item,
					icon: await DashboardIconsService.matchRepository(item.repository),
				})),
			),
			unreachable: null,
		}))
		.catch((error: unknown) => ({
			items: [],
			page: query.page,
			perPage: query.perPage,
			total: 0,
			unreachable: reason(error),
		}));
	return { listing, searched: query.q !== "" };
};

export const actions = {
	collectGarbage: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const busy = await ImageMirrorGcService.busyReason();
		if (busy) {
			return fail(409, { error: busy });
		}
		const job = await enqueueCleanup("pruneMirror", false, locals.user.id);
		return { jobId: job.id, success: true };
	},
};
