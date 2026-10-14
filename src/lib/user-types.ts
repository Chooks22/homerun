export const USER_TYPES = ["human", "service-account"] as const;

export type UserType = (typeof USER_TYPES)[number];

export const SERVICE_ACCOUNT: UserType = "service-account";

export const SERVICE_ACCOUNT_EMAIL_DOMAIN = "service-account.homerun.invalid";

export const SERVICE_ACCOUNT_DISABLED_MESSAGE =
	"This service account is disabled.";

export const BANNED_ACCOUNT_MESSAGE =
	"This account is banned, so its API keys and tokens are refused.";

export const SERVICE_ACCOUNT_MESSAGE =
	"A service account's key only gets through a login wall, plus the areas an admin granted it.";

/** Whether a user row is a service account: no sign-in method, only API keys. */
export function isServiceAccount(
	user: { type?: string | null } | null | undefined,
): boolean {
	return user?.type === SERVICE_ACCOUNT;
}

/** Whether `email` is the placeholder address a service account is created with, which no one can receive mail at. */
export function isServiceAccountEmail(email: string): boolean {
	return email.toLowerCase().endsWith(`@${SERVICE_ACCOUNT_EMAIL_DOMAIN}`);
}
