import { ServiceAccountService } from "#lib/services/service-account.service.js";

export const load = async () => ({
	accounts: await ServiceAccountService.list(),
});
