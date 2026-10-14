import { createHash, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, magicLink } from "better-auth/plugins";
import { type EmailSignIn, NO_EMAIL_SIGN_IN } from "#lib/auth-providers.js";
import { config, isSmtpEnabled } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { Logger } from "#lib/logger.js";
import { REDIRECT_TO_PARAM, safeRedirectTarget } from "#lib/redirect-target.js";
import { withDashboardOrigin } from "#lib/server/canonical-origin.js";
import { brandedEmail } from "#lib/server/email-layout.js";
import { isServiceAccountEmail } from "#lib/user-types.js";
import { EmailService } from "./email.service.ts";

const logger = new Logger("EmailSignIn");

export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
export const EMAIL_CODE_ATTEMPTS = 5;
export const MAGIC_LINK_PATH = "/auth/magic-link";

const SEND_CODE_PATH = "/email-otp/send-verification-otp";
const SIGN_IN_CODE_PATH = "/sign-in/email-otp";
const SEND_LINK_PATH = "/sign-in/magic-link";
const VERIFY_LINK_PATH = "/magic-link/verify";

const GUARDED_PATHS: Record<string, keyof EmailSignIn> = {
	[SEND_CODE_PATH]: "emailOtp",
	[SEND_LINK_PATH]: "magicLink",
	[SIGN_IN_CODE_PATH]: "emailOtp",
	[VERIFY_LINK_PATH]: "magicLink",
};

const TURNED_OFF: Record<keyof EmailSignIn, string> = {
	emailOtp: "Signing in with an emailed code is turned off on this instance.",
	magicLink: "Signing in with an emailed link is turned off on this instance.",
};

/**
 * The emailOTP plugin's endpoints Homerun doesn't use: password reset, email
 * verification and email change by code. Disabled so they can't be called
 * around the sign-in page.
 */
export const UNUSED_EMAIL_OTP_PATHS = [
	"/email-otp/check-verification-otp",
	"/email-otp/verify-email",
	"/email-otp/request-password-reset",
	"/email-otp/reset-password",
	"/forget-password/email-otp",
	"/email-otp/request-email-change",
	"/email-otp/change-email",
];

/**
 * The sign-in paths better-auth's two-factor challenge covers: password, plus
 * the emailed code and link, which only prove the mailbox, so an account with
 * an authenticator app still has to enter its code.
 */
export const TWO_FACTOR_SIGN_IN_PATHS = new Set([
	"/sign-in/email",
	SIGN_IN_CODE_PATH,
	VERIFY_LINK_PATH,
]);

/** The `verification` row marking an admin-created account still waiting for its first password. */
export function accountSetupPendingKey(userId: string): string {
	return `account-setup:${userId}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashSecret(value: string): Promise<string> {
	return Promise.resolve(sha256(value));
}

/** Compares two hex digests in constant time; false for any length mismatch. */
function sameDigest(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether a stored emailOTP verification value (`<hash>:<attempts>`) matches
 * `code`, is still live and has attempts left.
 */
export function storedCodeMatches(
	stored: { expiresAt: Date; value: string },
	code: string,
	now: Date = new Date(),
): boolean {
	if (stored.expiresAt < now) {
		return false;
	}
	const separator = stored.value.lastIndexOf(":");
	const hash =
		separator === -1 ? stored.value : stored.value.slice(0, separator);
	const attempts =
		separator === -1 ? 0 : Number(stored.value.slice(separator + 1) || 0);
	if (attempts >= EMAIL_CODE_ATTEMPTS) {
		return false;
	}
	return sameDigest(hash, sha256(code.trim()));
}

/**
 * The emailed sign-in methods usable right now: what an admin switched on
 * under Authentication, and nothing at all while SMTP isn't configured.
 */
export async function emailSignInAvailability(): Promise<EmailSignIn> {
	if (!isSmtpEnabled()) {
		return NO_EMAIL_SIGN_IN;
	}
	return (await InstanceSettingsDTO.get()).emailSignIn;
}

/** The sign-in code email, branded HTML plus its plain-text twin. */
export function signInCodeEmail(code: string): {
	content: string;
	html: string;
	subject: string;
} {
	const where = config.auth.origin ? ` at ${config.auth.origin}` : "";
	return {
		...brandedEmail({
			code,
			footnote: `If you didn't try to sign in to Homerun${where}, ignore this email: nobody can sign in without the code.`,
			heading: "Your sign-in code",
			paragraphs: [
				`Enter this code on the sign-in page to finish signing in. It expires in ${EMAIL_CODE_TTL_SECONDS / 60} minutes and works once.`,
			],
			preheader: `${code} is your Homerun sign-in code.`,
		}),
		subject: `${code} is your Homerun sign-in code`,
	};
}

/** The sign-in link email. */
export function signInLinkEmail(link: string): {
	content: string;
	html: string;
	subject: string;
} {
	return {
		...brandedEmail({
			action: { label: "Sign in to Homerun", url: link },
			footnote:
				"If you didn't ask to sign in, ignore this email: nobody can sign in without the link.",
			heading: "Sign in to Homerun",
			paragraphs: [
				`Use the button below to sign in. The link expires in ${EMAIL_CODE_TTL_SECONDS / 60} minutes and works once, in whichever browser you open it.`,
			],
		}),
		subject: "Your Homerun sign-in link",
	};
}

/**
 * The page a sign-in link opens: Homerun's own `/auth/magic-link`, on the
 * Dashboard URL, carrying the token and a same-origin `redirectTo`. The token
 * is only spent when the visitor clicks through, so a mail scanner fetching
 * the link can't burn it.
 */
export function magicLinkLandingUrl(
	verifyUrl: string,
	token: string,
	redirectTo: unknown,
): string {
	const landing = new URL(
		MAGIC_LINK_PATH,
		new URL(withDashboardOrigin(verifyUrl)).origin,
	);
	landing.searchParams.set("token", token);
	const target = safeRedirectTarget(
		typeof redirectTo === "string" ? redirectTo : null,
	);
	if (target) {
		landing.searchParams.set(REDIRECT_TO_PARAM, target);
	}
	return landing.toString();
}

/**
 * The email a still-live sign-in link was sent to, without spending it, or
 * null when the token is unknown, used or expired.
 */
export async function magicLinkEmail(token: string): Promise<string | null> {
	const { auth } = await import("./auth.ts");
	const ctx = await auth.$context;
	const stored = await ctx.internalAdapter.findVerificationValue(sha256(token));
	if (!stored || stored.expiresAt < new Date()) {
		return null;
	}
	return (JSON.parse(stored.value) as { email?: string }).email ?? null;
}

export interface SignInAdapter {
	deleteVerificationByIdentifier: (identifier: string) => Promise<void>;
	findUserByEmail: (
		email: string,
	) => Promise<{ user: { emailVerified: boolean; id: string } } | null>;
	findVerificationValue: (
		identifier: string,
	) => Promise<{ expiresAt: Date; value: string } | null>;
	updateUser: (
		userId: string,
		data: { emailVerified: boolean },
	) => Promise<unknown>;
}

export interface GuardedRequest {
	body?: { email?: unknown; otp?: unknown; type?: unknown };
	path: string;
	query?: { token?: unknown };
}

/**
 * Marks the account behind `email` as proven: its email verified, and its
 * pending first-password setup cleared since it chose to sign in by email.
 * Runs before better-auth signs an unverified account in by email, which would
 * otherwise strip its password, linked providers and sessions (its defence
 * against an account pre-registered by someone else, which can't happen here:
 * every account is created by an admin or an invite).
 */
async function proveEmail(
	adapter: SignInAdapter,
	email: string,
): Promise<void> {
	const found = await adapter.findUserByEmail(email.toLowerCase());
	if (!found) {
		return;
	}
	await adapter.deleteVerificationByIdentifier(
		accountSetupPendingKey(found.user.id),
	);
	if (!found.user.emailVerified) {
		await adapter.updateUser(found.user.id, { emailVerified: true });
	}
}

/**
 * Runs before every emailed sign-in endpoint: refuses it while its method is
 * off or SMTP isn't configured, only lets codes be requested for signing in,
 * and proves the account's email once the code or link checks out (see
 * `proveEmail`). Other paths pass through untouched.
 *
 * @throws An `APIError` refusing the request.
 */
export async function guardEmailSignIn(
	request: GuardedRequest,
	adapter: SignInAdapter,
): Promise<void> {
	const method = GUARDED_PATHS[request.path];
	if (!method) {
		return;
	}
	if (!(await emailSignInAvailability())[method]) {
		throw new APIError("FORBIDDEN", { message: TURNED_OFF[method] });
	}
	if (request.path === SEND_CODE_PATH && request.body?.type !== "sign-in") {
		throw new APIError("BAD_REQUEST", {
			message: "Only sign-in codes can be requested.",
		});
	}
	if (request.path === SIGN_IN_CODE_PATH) {
		const email = String(request.body?.email ?? "").toLowerCase();
		const stored = await adapter.findVerificationValue(`sign-in-otp-${email}`);
		if (stored && storedCodeMatches(stored, String(request.body?.otp ?? ""))) {
			await proveEmail(adapter, email);
		}
	}
	if (request.path === VERIFY_LINK_PATH) {
		const stored = await adapter.findVerificationValue(
			sha256(String(request.query?.token ?? "")),
		);
		if (stored && stored.expiresAt >= new Date()) {
			const { email } = JSON.parse(stored.value) as { email: string };
			await proveEmail(adapter, email);
		}
	}
}

/** The better-auth plugin running `guardEmailSignIn` before the emailed sign-in endpoints. */
function emailSignInGuard() {
	return {
		hooks: {
			before: [
				{
					handler: createAuthMiddleware((ctx) =>
						guardEmailSignIn(
							{ body: ctx.body, path: ctx.path ?? "", query: ctx.query },
							ctx.context.internalAdapter,
						),
					),
					matcher: (ctx) => (ctx.path ?? "") in GUARDED_PATHS,
				},
			],
		},
		id: "homerun-email-sign-in",
	} satisfies BetterAuthPlugin;
}

/**
 * better-auth's emailed sign-in plugins, wired to Homerun's SMTP sender: a
 * 6-digit code (10 minutes, five tries, stored hashed) and a one-time link
 * (10 minutes, stored hashed), neither able to create an account, plus the
 * guard that enforces the Authentication page's switches. Registered always;
 * whether they work is decided per request, so toggling needs no rebuild.
 */
export function emailSignInPlugins() {
	return [
		emailOTP({
			allowedAttempts: EMAIL_CODE_ATTEMPTS,
			disableSignUp: true,
			expiresIn: EMAIL_CODE_TTL_SECONDS,
			sendVerificationOTP: async ({ email, otp }) => {
				if (isServiceAccountEmail(email)) {
					return;
				}
				await new EmailService({ ...signInCodeEmail(otp), to: email }).send();
				logger.info(`Sign-in code emailed to ${email}`);
			},
			storeOTP: { hash: hashSecret },
		}),
		magicLink({
			disableSignUp: true,
			expiresIn: EMAIL_CODE_TTL_SECONDS,
			sendMagicLink: async ({ email, metadata, token, url }, ctx) => {
				if (
					isServiceAccountEmail(email) ||
					!(await ctx?.context.internalAdapter.findUserByEmail(email))
				) {
					return;
				}
				const link = magicLinkLandingUrl(url, token, metadata?.redirectTo);
				await new EmailService({ ...signInLinkEmail(link), to: email }).send();
				logger.info(`Sign-in link emailed to ${email}`);
			},
			storeToken: { hash: hashSecret, type: "custom-hasher" },
		}),
		emailSignInGuard(),
	] as const;
}
