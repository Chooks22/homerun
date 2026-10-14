import { asAuthRole } from "#lib/permissions.js";
import { jsonPage, parseApiListQuery } from "#lib/server/api-pagination.js";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { userApiJson } from "#lib/server/identity-api-json.js";
import { createUserApiBody } from "#lib/server/validation/identity-api.js";
import { AccountSetupService } from "#lib/services/account-setup.service.js";
import { UserService } from "#lib/services/user.service.js";

export const GET = async ({ locals, url }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const paged = await UserService.listUsersPaged(
		parseApiListQuery(url, ["role"]),
	);
	return jsonPage(paged.items.map(userApiJson), paged);
};

export const POST = async ({ locals, request }) => {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, createUserApiBody);
	if ("response" in body) {
		return body.response;
	}
	const { email, name, permissions, role } = body.data;
	if (permissions && role !== "custom") {
		return apiError("Only a custom-role user has their own permissions.");
	}
	if (await UserService.findByEmail(email)) {
		return apiError("That email already has an account.");
	}
	const userId = await AccountSetupService.createPendingUser({
		email,
		name,
		role: asAuthRole(role),
	});
	if (role === "custom") {
		await UserService.setRole(userId, role, permissions ?? {});
	}
	const created = await UserService.getUser(userId);
	return created
		? Response.json(userApiJson(created), { status: 201 })
		: apiError("Could not create user.", 500);
};
