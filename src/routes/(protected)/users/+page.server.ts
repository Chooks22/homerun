import { fail } from "@sveltejs/kit";
import { config, isSmtpEnabled } from "#lib/config.js";
import { InvitationDTO } from "#lib/dto/invitation-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import {
	asAuthRole,
	isUserRole,
	permissionsFromForm,
	roleLabel,
} from "#lib/permissions.js";
import { brandedEmail } from "#lib/server/email-layout.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { AccountSetupService } from "#lib/services/account-setup.service.js";
import { EmailService } from "#lib/services/email.service.js";
import { UserService } from "#lib/services/user.service.js";

const logger = new Logger("Users");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load = async ({ parent, url }) => {
	const { preferences, user } = await parent();
	const query = parseListQuery(
		url,
		{ filterKeys: ["role"], sortKeys: sortKeysOf(BASE_SORTS) },
		preferences.perPage,
	);
	const [users, invites] = await Promise.all([
		UserService.listUsersPaged(query),
		InvitationDTO.listPending(),
	]);

	return {
		currentUserId: user.id,
		filtered: query.active,
		invites: invites.map((i) => i.toJSON()),
		page: users.page,
		perPage: users.perPage,
		smtpEnabled: isSmtpEnabled(),
		total: users.total,
		users: users.items,
	};
};

export const actions = {
	cancelInvite: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const id = formData.get("id") as string;
		await InvitationDTO.deleteById(id);
		return { action: "cancelInvite", success: true };
	},

	createDirect: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim();
		const email = (formData.get("email") as string | null)
			?.trim()
			.toLowerCase();
		const role = formData.get("role");

		if (!(name && email)) {
			return fail(400, {
				action: "createDirect",
				error: "Name and email are required.",
			});
		}
		if (!isUserRole(role) || role === "custom") {
			return fail(400, { action: "createDirect", error: "Invalid role." });
		}

		const created = await AccountSetupService.createPendingUser({
			email,
			name,
			role: asAuthRole(role),
		}).catch((error: unknown) => ({ error }));
		if (typeof created !== "string") {
			logger.warn(`Direct user creation failed: ${created.error}`);
			return fail(400, {
				action: "createDirect",
				error:
					created.error instanceof Error
						? created.error.message
						: "Could not create user.",
			});
		}

		logger.info(
			`User created directly: user=${created} role=${role} by=${locals.user.id}`,
		);
		return { action: "createDirect", success: true };
	},

	invite: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		if (!isSmtpEnabled()) {
			return fail(400, {
				action: "invite",
				error: "Configure SMTP in Settings before sending invites.",
			});
		}

		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim();
		const email = (formData.get("email") as string | null)
			?.trim()
			.toLowerCase();
		const role = formData.get("role");

		if (!(name && email)) {
			return fail(400, {
				action: "invite",
				error: "Name and email are required.",
			});
		}
		if (!isUserRole(role) || role === "custom") {
			return fail(400, { action: "invite", error: "Invalid role." });
		}

		const existing = await UserService.listUsers();
		if (existing.some((u) => u.email === email)) {
			return fail(400, {
				action: "invite",
				error: "That email already has an account.",
			});
		}

		const invitation = await InvitationDTO.create({
			email,
			invitedByUserId: locals.user.id,
			role,
		});
		const link = `${config.auth.origin}/auth/accept-invite/${invitation.toJSON().token}`;

		try {
			const mail = new EmailService({
				...brandedEmail({
					action: { label: "Set up my account", url: link },
					details: [{ name: "Role", value: roleLabel(role) }],
					footnote:
						"The invite expires in 7 days. If you weren't expecting it, ignore this email.",
					heading: "You've been invited to Homerun",
					paragraphs: [
						`${name}, you've been invited to join Homerun. Set up your account to get started.`,
					],
				}),
				subject: "You've been invited to Homerun",
				to: email,
			});
			await mail.send();
		} catch (error) {
			logger.error("Failed to send invite email", error);
			return fail(500, {
				action: "invite",
				error:
					"Invite created but the email failed to send : check SMTP settings.",
			});
		}

		logger.info(
			`Invite sent: email=${email} role=${role} by=${locals.user.id}`,
		);
		return { action: "invite", success: true };
	},

	removeUser: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const userId = formData.get("userId") as string;

		const refusal = await UserService.removeUser(userId, locals.user.id);
		if (refusal) {
			return fail(400, { action: "removeUser", error: refusal });
		}

		logger.info(`User removed: user=${userId} by=${locals.user.id}`);
		return { action: "removeUser", success: true };
	},

	setEmail: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const userId = formData.get("userId") as string;
		const email = (formData.get("email") as string | null)
			?.trim()
			.toLowerCase();

		if (!(userId && email && EMAIL_RE.test(email))) {
			return fail(400, {
				action: "setEmail",
				error: "Enter a valid email address.",
			});
		}
		const target = await UserService.getUser(userId);
		if (!target) {
			return fail(404, { action: "setEmail", error: "User not found." });
		}
		const refusal = await UserService.changeEmail(target, email);
		if (refusal) {
			return fail(400, { action: "setEmail", error: refusal });
		}
		logger.info(
			`Email changed: user=${userId} from=${target.email} to=${email} by=${locals.user.id}`,
		);
		return { action: "setEmail", success: true };
	},

	setRole: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const userId = formData.get("userId") as string;
		const role = formData.get("role");

		if (!isUserRole(role)) {
			return fail(400, { action: "setRole", error: "Invalid role." });
		}

		const target = await UserService.getUser(userId);
		if (!target) {
			return fail(404, { action: "setRole", error: "User not found." });
		}
		const refusal = await UserService.changeRole(target, role);
		if (refusal) {
			return fail(400, { action: "setRole", error: refusal });
		}
		logger.info(
			`Role changed: user=${userId} role=${role} by=${locals.user.id}`,
		);
		return { action: "setRole", success: true };
	},

	setPermissions: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}

		const formData = await request.formData();
		const userId = formData.get("userId") as string;
		const target = await UserService.getUser(userId);
		if (!target) {
			return fail(404, { action: "setPermissions", error: "User not found." });
		}
		const permissions = permissionsFromForm(formData);
		const refusal = await UserService.changePermissions(target, permissions);
		if (refusal) {
			return fail(400, { action: "setPermissions", error: refusal });
		}
		logger.info(
			`Permissions changed: user=${userId} permissions=${JSON.stringify(permissions)} by=${locals.user.id}`,
		);
		return { action: "setPermissions", success: true };
	},
};
