import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { queueCleanup } from "#lib/services/docker-cleanup-queue.js";

export const actions = {
	pruneBuildCache: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await queueCleanup("pruneBuildCache", false, locals.user.id);
	},

	pruneContainers: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await queueCleanup("pruneContainers", false, locals.user.id);
	},

	pruneImages: async ({ locals, request }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		return await queueCleanup(
			"pruneImages",
			formData.get("all") === "on",
			locals.user.id,
		);
	},

	pruneMirror: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await queueCleanup("pruneMirror", false, locals.user.id);
	},

	reclaimStackNetworks: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await queueCleanup("reclaimStackNetworks", false, locals.user.id);
	},

	pruneNetworks: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await queueCleanup("pruneNetworks", false, locals.user.id);
	},

	pruneSystem: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await queueCleanup("pruneSystem", false, locals.user.id);
	},

	pruneVolumes: async ({ locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return await queueCleanup("pruneVolumes", false, locals.user.id);
	},
};
