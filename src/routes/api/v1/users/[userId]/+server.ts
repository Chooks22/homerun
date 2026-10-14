import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { userApiJson } from "#lib/server/identity-api-json.js";
import { updateUserApiBody } from "#lib/server/validation/identity-api.js";
import { UserService } from "#lib/services/user.service.js";
import { SERVICE_ACCOUNT } from "#lib/user-types.js";

/** The human account behind `userId`, null for an unknown id or a service account. */
async function person(userId: string) {
	const user = await UserService.getUser(userId);
	return user && user.type !== SERVICE_ACCOUNT ? user : null;
}

export const GET = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const user = await person(params.userId);
	return user ? Response.json(userApiJson(user)) : apiError("Not found", 404);
};

export const PATCH = async ({ locals, params, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const user = await person(params.userId);
	if (!user) {
		return apiError("Not found", 404);
	}
	const body = await readApiBody(request, updateUserApiBody);
	if ("response" in body) {
		return body.response;
	}
	const refusal = await UserService.updateAccount(user, body.data);
	if (refusal) {
		return apiError(refusal);
	}
	const updated = await UserService.getUser(user.id);
	return updated
		? Response.json(userApiJson(updated))
		: apiError("Not found", 404);
};

export const DELETE = async ({ locals, params }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	if (!(await person(params.userId))) {
		return apiError("Not found", 404);
	}
	const refusal = await UserService.removeUser(params.userId, caller.userId);
	return refusal ? apiError(refusal) : new Response(null, { status: 204 });
};
