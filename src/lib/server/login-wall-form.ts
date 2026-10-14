import {
	type EmailSignIn,
	signInMethodAvailable,
} from "#lib/auth-providers.js";

const EMAIL_PATTERN_RE = /^(\*|[^\s@]+)@[^\s@]+\.[^\s@]+$/;

export interface LoginWallPolicy {
	authAllowedEmails: string[];
	authAllowedGroups: string[];
	authAllowedUserIds: string[];
	authProviders: string[];
	authRequired: boolean;
}

export interface LoginWallAvailability {
	email: EmailSignIn;
	oauthProviders: Set<string>;
}

/** Splits a textarea of comma- or newline-separated entries into trimmed, de-duplicated values. */
export function splitList(raw: string | null): string[] {
	return [
		...new Set(
			(raw ?? "")
				.split(/[\n,]/)
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
}

/**
 * Why a login-wall policy can't be saved, or null: a method that isn't
 * enabled on this instance, a wall with no method, a wall without a
 * dashboard URL to redirect to, or a malformed email pattern.
 */
export function loginWallPolicyProblem(
	policy: LoginWallPolicy,
	available: LoginWallAvailability,
	dashboardOrigin: string | null | undefined,
): string | null {
	const unavailable = policy.authProviders.find(
		(method) => !signInMethodAvailable(method, available),
	);
	if (unavailable) {
		return `"${unavailable}" isn't an enabled sign-in method on this instance.`;
	}
	if (policy.authRequired && policy.authProviders.length === 0) {
		return "Pick at least one sign-in method, otherwise nobody (including you) can get in.";
	}
	if (policy.authRequired && !dashboardOrigin) {
		return "Set the Dashboard URL under Settings → General first : the login wall redirects visitors to this instance's own sign-in page, so Homerun has to know its own public URL.";
	}
	const badEmail = policy.authAllowedEmails.find(
		(entry) => !EMAIL_PATTERN_RE.test(entry),
	);
	return badEmail
		? `"${badEmail}" isn't an email address or a *@domain pattern.`
		: null;
}

/**
 * Reads a login-wall form's fields (the checkbox, sign-in methods, allowed
 * users, emails and groups) into a policy, without checking it.
 */
export function loginWallFromForm(formData: FormData): LoginWallPolicy {
	return {
		authAllowedEmails: splitList(
			formData.get("authAllowedEmails") as string | null,
		),
		authAllowedGroups: splitList(
			formData.get("authAllowedGroups") as string | null,
		),
		authAllowedUserIds: [
			...new Set(formData.getAll("authAllowedUserId").map(String)),
		],
		authProviders: [...new Set(formData.getAll("authProvider").map(String))],
		authRequired: formData.get("authRequired") === "on",
	};
}

/**
 * Reads a login-wall form into a policy, or the reason it can't be saved
 * (see `loginWallPolicyProblem`).
 */
export function parseLoginWallForm(
	formData: FormData,
	available: LoginWallAvailability,
	dashboardOrigin: string | null | undefined,
): { error: string } | { policy: LoginWallPolicy } {
	const policy = loginWallFromForm(formData);
	const error = loginWallPolicyProblem(policy, available, dashboardOrigin);
	return error ? { error } : { policy };
}
