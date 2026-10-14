import { error } from "@sveltejs/kit";
import { ServiceAccountService } from "#lib/services/service-account.service.js";

export const load = async ({ params }) => {
	const account = await ServiceAccountService.get(params.accountId);
	if (!account) {
		error(404, "That service account doesn't exist.");
	}
	return { account };
};
