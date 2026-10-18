import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";

/**
 * Sends a signed-out request to the sign-in page.
 *
 * @throws Always: SvelteKit's 302 redirect.
 */
export function redirectToSignIn(): never {
	throw redirect(302, resolve("auth/sign-in"));
}
