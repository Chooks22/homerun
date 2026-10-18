import { redirect } from "@sveltejs/kit";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { GIT_CONNECT_RETURN_COOKIE } from "#lib/git-webhooks.js";
import { Logger } from "#lib/logger.js";
import { safeRedirectTarget } from "#lib/redirect-target.js";
import { browserOrigin } from "#lib/server/canonical-origin.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { GitProviderService } from "#lib/services/git-provider.service.js";
import { GitWebhookService } from "#lib/services/git-webhook.service.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { WorkstationSignInService } from "#lib/services/workstation/sign-in.js";
import { resolve } from "$app/paths";

const logger = new Logger("GitProviders");

async function workstationSignIn(
	providerId: string,
	url: URL,
	state: string,
): Promise<Response> {
	const code = url.searchParams.get("code");
	if (!code) {
		return new Response(
			"The git provider didn't sign you in. Open the workstation again to retry.",
			{ status: 403 },
		);
	}
	let target: string;
	try {
		target = await WorkstationSignInService.complete(providerId, code, state);
	} catch (err) {
		logger.warn(`Workstation sign-in failed: provider=${providerId}`, err);
		return new Response(
			err instanceof Error ? err.message : "The sign-in failed.",
			{ headers: { "content-type": "text/plain; charset=utf-8" }, status: 403 },
		);
	}
	throw redirect(302, target, { external: true });
}

export const GET = async ({ cookies, params, locals, request, url }) => {
	const signInState = url.searchParams.get("state");
	if (signInState && WorkstationSignInService.ownsState(signInState)) {
		return await workstationSignIn(params.providerId, url, signInState);
	}
	if (!locals.user) {
		redirectToSignIn();
	}
	const returnTo = safeRedirectTarget(
		cookies.get(GIT_CONNECT_RETURN_COOKIE) ?? null,
	);
	cookies.delete(GIT_CONNECT_RETURN_COOKIE, { path: "/" });
	const done = returnTo ?? resolve("git-providers");

	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const oauthError = url.searchParams.get("error");

	if (oauthError) {
		logger.warn(`OAuth error from provider: ${oauthError}`);
		throw redirect(303, done);
	}
	if (!(code && state)) {
		return new Response("Missing code/state.", { status: 400 });
	}
	if (
		!GitProviderService.verifyState(state, params.providerId, locals.user.id)
	) {
		return new Response("Invalid or expired state.", { status: 400 });
	}

	const settings = await InstanceSettingsDTO.get();
	const provider = settings.gitProviders.find(
		(p) => p.id === params.providerId,
	);
	if (!provider) {
		return new Response("Git provider not found.", { status: 404 });
	}

	try {
		const redirectUri = `${browserOrigin(request, url)}/api/v1/git-providers/${provider.id}/callback`;
		const exchanged = await GitProviderService.exchangeCode(
			provider,
			code,
			redirectUri,
		);

		await GitConnectionDTO.upsert({
			accessTokenEnc: encryptSecret(exchanged.accessToken),
			expiresAt: exchanged.expiresAt,
			providerId: provider.id,
			providerKind: provider.kind,
			providerUsername: exchanged.providerUsername,
			refreshTokenEnc: exchanged.refreshToken
				? encryptSecret(exchanged.refreshToken)
				: null,
			userId: locals.user.id,
		});

		logger.info(
			`Git provider connected: provider=${provider.id} kind=${provider.kind} account=${exchanged.providerUsername} user=${locals.user.id}`,
		);
		await GitWebhookService.retryAfterReconnect(locals.user.id, provider.id);
	} catch (err) {
		logger.error(
			`Git provider connect failed: provider=${provider.id} user=${locals.user.id}`,
			err,
		);
	}

	throw redirect(303, done);
};
