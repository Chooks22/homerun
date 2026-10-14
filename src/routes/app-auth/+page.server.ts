import { error, redirect } from "@sveltejs/kit";
import { signInMethodAvailable } from "#lib/auth-providers.js";
import { config } from "#lib/config.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { authBranding } from "#lib/error-pages.js";
import { signInUrlFor } from "#lib/redirect-target.js";
import {
	GATE_CALLBACK_PATH,
	GATE_GRANT_TTL_MS,
	gatePrefix,
	signGateToken,
	verifyGateToken,
} from "#lib/server/app-gate.js";
import { offCanonicalOrigin } from "#lib/server/canonical-origin.js";
import { clientAddress } from "#lib/server/client-address.js";
import { gatedService } from "#lib/server/gated-service-cache.js";
import {
	ACCESS_DENIAL_MESSAGES,
	AppAccessService,
} from "#lib/services/app-access.service.js";
import { emailSignInAvailability } from "#lib/services/email-sign-in.js";
import { ServiceAccountService } from "#lib/services/service-account.service.js";
import { isServiceAccount } from "#lib/user-types.js";
import { resolve } from "$app/paths";

export const load = async (event) => {
	const { request: incoming, url, locals } = event;
	const canonicalOrigin = offCanonicalOrigin(incoming, url);
	if (canonicalOrigin) {
		redirect(302, `${canonicalOrigin}${url.pathname}${url.search}`, {
			external: true,
		});
	}

	const rd = url.searchParams.get("rd");
	const request = rd ? verifyGateToken(rd) : null;
	if (!request?.target) {
		error(
			400,
			"This sign-in link is invalid or has expired. Go back to the app and reload to get a fresh one.",
		);
	}

	const svc = await gatedService(request.serviceId);
	if (!svc?.authRequired) {
		error(404, "That app isn't gated behind Homerun's login.");
	}

	const available = {
		email: await emailSignInAvailability(),
		oauthProviders: new Set(
			config.auth.oauthProviders.filter((p) => p.enabled).map((p) => p.name),
		),
	};
	const serviceAccount = isServiceAccount(locals.user);
	const hasUsableMethod =
		serviceAccount ||
		svc.authProviders.some((method) =>
			signInMethodAvailable(method, available),
		);

	const base = {
		appName: svc.name,
		appUrl: request.target,
		branding: authBranding((await InstanceSettingsDTO.get()).errorPages),
	};

	if (!hasUsableMethod) {
		return { ...base, denial: null, noMethods: true, signedInAs: null };
	}

	if (!locals.user) {
		redirect(
			302,
			signInUrlFor(resolve("auth/sign-in"), `${url.pathname}${url.search}`),
		);
	}

	const decision = await AppAccessService.evaluate(svc, locals.user.id);
	if (serviceAccount) {
		await ServiceAccountService.recordUse(locals.user, {
			action: "gate.handshake",
			detail: `${svc.name} (${request.host}): ${decision.allowed ? "granted" : `refused, ${decision.reason}`}`,
			ipAddress: clientAddress(event),
			status: decision.allowed ? 302 : 403,
		});
	}
	if (!decision.allowed) {
		return {
			...base,
			denial: decision.reason
				? ACCESS_DENIAL_MESSAGES[decision.reason]
				: "You don't have access to this app.",
			noMethods: false,
			signedInAs: locals.user.email,
		};
	}

	const grant = signGateToken(
		{
			email: locals.user.email,
			host: request.host,
			name: locals.user.name,
			serviceId: svc.id,
			target: request.target,
			userId: locals.user.id,
		},
		GATE_GRANT_TTL_MS,
	);
	const target = new URL(request.target);
	const prefix = gatePrefix(svc.domains, target.host, target.pathname);
	const callback = new URL(`${prefix}${GATE_CALLBACK_PATH}`, target.origin);
	callback.searchParams.set("token", grant);
	redirect(302, callback.toString(), { external: true });
};
