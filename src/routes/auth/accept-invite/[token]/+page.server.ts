import { fail, redirect } from "@sveltejs/kit";
import { InvitationDTO } from "#lib/dto/invitation-dto.js";
import { Logger } from "#lib/logger.js";
import { asAuthRole } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { auth } from "#lib/services/auth.js";
import { emailSignInAvailability } from "#lib/services/email-sign-in.js";
import { resolve } from "$app/paths";

const logger = new Logger("AcceptInvite");

export const load = async ({ params }) => {
	const invitation = await InvitationDTO.getByToken(params.token);
	if (!invitation) {
		return { invalid: true as const };
	}
	const { email, role } = invitation.toJSON();
	const emailSignIn = await emailSignInAvailability();
	return {
		codesAvailable: emailSignIn.emailOtp || emailSignIn.magicLink,
		email,
		invalid: false as const,
		role,
	};
};

export const actions = {
	accept: async ({ request, params }) => {
		const invitation = await InvitationDTO.getByToken(params.token);
		if (!invitation) {
			return fail(400, { error: "This invite is invalid or has expired." });
		}

		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim();
		const password = (formData.get("password") as string | null) ?? "";
		const confirm = (formData.get("confirm") as string | null) ?? "";

		if (!name) {
			return fail(400, { error: "Name is required." });
		}
		if (password.length < 12) {
			return fail(400, { error: "Password must be at least 12 characters." });
		}
		if (password !== confirm) {
			return fail(400, { error: "Passwords don't match." });
		}

		const { email, role } = invitation.toJSON();
		// No `headers` here : confirmed against
		// node_modules/better-auth/dist/plugins/admin/routes.mjs's createUser:
		// omitting headers/request context is treated as a trusted server-side
		// call and skips the admin-role permission check entirely, which is
		// correct here : the invite token itself (validated, single-use,
		// expiring) is the authorization, not an admin session.
		const result = await auth.api
			.createUser({
				body: {
					data: { emailVerified: true },
					email,
					name,
					password,
					role: asAuthRole(role),
				},
			})
			.catch((error: unknown) => ({ error }));
		if ("error" in result) {
			logger.warn(`Invite acceptance failed: email=${email} ${result.error}`);
			return fail(400, {
				error:
					result.error instanceof Error
						? result.error.message
						: "Could not create your account.",
			});
		}

		await invitation.markAccepted();
		logger.info(`Invite accepted: user=${result.user.id} email=${email}`);
		redirectToSignIn();
	},
	acceptWithCodes: async ({ request, params }) => {
		const invitation = await InvitationDTO.getByToken(params.token);
		if (!invitation) {
			return fail(400, { error: "This invite is invalid or has expired." });
		}
		const emailSignIn = await emailSignInAvailability();
		if (!(emailSignIn.emailOtp || emailSignIn.magicLink)) {
			return fail(400, {
				error:
					"Signing in with emailed codes is turned off on this instance. Choose a password instead.",
			});
		}
		const formData = await request.formData();
		const name = (formData.get("name") as string | null)?.trim();
		if (!name) {
			return fail(400, { error: "Name is required." });
		}

		const { email, role } = invitation.toJSON();
		const result = await auth.api
			.createUser({
				body: {
					data: { emailVerified: true },
					email,
					name,
					role: asAuthRole(role),
				},
			})
			.catch((error: unknown) => ({ error }));
		if ("error" in result) {
			logger.warn(`Invite acceptance failed: email=${email} ${result.error}`);
			return fail(400, {
				error:
					result.error instanceof Error
						? result.error.message
						: "Could not create your account.",
			});
		}

		await invitation.markAccepted();
		logger.info(
			`Invite accepted without a password: user=${result.user.id} email=${email}`,
		);

		throw redirect(
			302,
			`${resolve("auth/sign-in")}?${new URLSearchParams({ email })}`,
		);
	},
};
