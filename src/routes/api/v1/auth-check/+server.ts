import { config } from "#lib/config.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import {
	GATE_CALLBACK_PATH,
	GATE_LOGOUT_PATH,
	GATE_REDIRECT_TTL_MS,
	GATE_SESSION_TTL_MS,
	gateCookie,
	policyVersion,
	readGateCookie,
	signGateToken,
	verifyGateToken,
} from "#lib/server/app-gate.js";
import { cachedGateAccess } from "#lib/server/gate-access-cache.js";
import { gateChallengeKind } from "#lib/server/gate-request.js";
import { gatedService } from "#lib/server/gated-service-cache.js";
import { AppAccessService } from "#lib/services/app-access.service.js";
import {
	WorkstationSignInService,
	workstationGateKey,
} from "#lib/services/workstation/sign-in.js";

const logger = new Logger("AppGate");

interface ForwardedRequest {
	host: string;
	origin: string;
	path: string;
	search: string;
	secure: boolean;
	url: string;
}

function readForwarded(request: Request, fallback: URL): ForwardedRequest {
	const host = request.headers.get("x-forwarded-host") ?? fallback.host;
	const proto = request.headers.get("x-forwarded-proto") ?? "https";
	const uri = request.headers.get("x-forwarded-uri") ?? "/";
	const queryAt = uri.indexOf("?");
	const path = queryAt === -1 ? uri : uri.slice(0, queryAt);
	const search = queryAt === -1 ? "" : uri.slice(queryAt);
	const origin = `${proto}://${host}`;
	return {
		host,
		origin,
		path,
		search,
		secure: proto === "https",
		url: `${origin}${uri}`,
	};
}

function deny(message: string, status: number): Response {
	return new Response(message, {
		headers: { "content-type": "text/plain; charset=utf-8" },
		status,
	});
}

function redirect(to: string, cookie?: string): Response {
	const headers = new Headers({ location: to });
	if (cookie) {
		headers.append("set-cookie", cookie);
	}
	return new Response(null, { headers, status: 302 });
}

function challenge(svc: ServiceDTO, forwarded: ForwardedRequest): Response {
	const dashboard = config.auth.origin;
	if (!dashboard) {
		return deny(
			"This app is gated behind Homerun's login, but Homerun doesn't know its own public URL yet, so it can't send you to a sign-in page. Set the Dashboard URL under Settings → General.",
			500,
		);
	}
	const token = signGateToken(
		{ host: forwarded.host, serviceId: svc.id, target: forwarded.url },
		GATE_REDIRECT_TTL_MS,
	);
	const to = new URL("/app-auth", dashboard);
	to.searchParams.set("rd", token);
	return redirect(to.toString());
}

async function handleCallback(
	svc: ServiceDTO,
	forwarded: ForwardedRequest,
): Promise<Response> {
	const token = new URLSearchParams(forwarded.search).get("token");
	const payload = token ? verifyGateToken(token) : null;
	if (
		!payload?.userId ||
		payload.serviceId !== svc.id ||
		payload.host !== forwarded.host
	) {
		return challenge(svc, forwarded);
	}

	const decision = await AppAccessService.evaluate(svc, payload.userId);
	if (!decision.allowed) {
		return challenge(svc, forwarded);
	}

	const session = signGateToken(
		{
			email: payload.email,
			host: forwarded.host,
			name: payload.name,
			policyVersion: policyVersion(svc),
			serviceId: svc.id,
			userId: payload.userId,
		},
		GATE_SESSION_TTL_MS,
	);
	logger.info(
		`App gate granted: service=${svc.id} user=${payload.userId} host=${forwarded.host}`,
	);
	return redirect(
		payload.target ?? forwarded.origin,
		gateCookie(session, forwarded.secure, GATE_SESSION_TTL_MS / 1000),
	);
}

async function stillAllowed(
	svc: ServiceDTO,
	userId: string,
	currentPolicy: string,
): Promise<boolean> {
	try {
		return await cachedGateAccess(
			{ policyVersion: currentPolicy, serviceId: svc.id, userId },
			() => AppAccessService.recheck(svc, userId),
		);
	} catch (error) {
		logger.error(
			`App gate re-check failed, honouring the cookie: service=${svc.id} user=${userId}`,
			error,
		);
		return true;
	}
}

async function checkWorkstation(
	request: Request,
	url: URL,
	workstationId: string,
): Promise<Response> {
	const gate = await WorkstationSignInService.gate(workstationId);
	if (!gate) {
		return deny(
			"This workstation signs in through git, but its git connection is gone. Start it again from Homerun to go back to its password.",
			403,
		);
	}
	const forwarded = readForwarded(request, url);
	if (forwarded.host !== gate.hostname) {
		return deny("Unauthorized", 401);
	}
	const key = workstationGateKey(gate.id);

	if (forwarded.path === GATE_LOGOUT_PATH) {
		return redirect(forwarded.origin, gateCookie("", forwarded.secure, 0));
	}
	if (forwarded.path === GATE_CALLBACK_PATH) {
		const token = new URLSearchParams(forwarded.search).get("token");
		const grant = token ? verifyGateToken(token) : null;
		if (
			grant?.userId !== gate.ownerId ||
			grant.serviceId !== key ||
			grant.host !== forwarded.host
		) {
			return redirect(
				WorkstationSignInService.challengeUrl(
					gate,
					forwarded.host,
					forwarded.origin,
				),
			);
		}
		return redirect(
			grant.target ?? forwarded.origin,
			gateCookie(
				WorkstationSignInService.session(gate, forwarded.host),
				forwarded.secure,
				GATE_SESSION_TTL_MS / 1000,
			),
		);
	}

	const cookie = readGateCookie(request.headers.get("cookie"));
	const payload = cookie ? verifyGateToken(cookie) : null;
	if (
		payload?.userId === gate.ownerId &&
		payload.serviceId === key &&
		payload.host === forwarded.host &&
		payload.policyVersion === gate.version
	) {
		return new Response("OK", { status: 200 });
	}

	const kind = gateChallengeKind(request.headers, forwarded.path);
	if (kind === "allow") {
		return new Response("OK", { status: 200 });
	}
	if (kind === "deny") {
		return deny("Sign in to this workstation first.", 401);
	}
	return redirect(
		WorkstationSignInService.challengeUrl(gate, forwarded.host, forwarded.url),
	);
}

export const GET = async ({ request, url }) => {
	const workstationId = url.searchParams.get("workstation");
	if (workstationId) {
		return await checkWorkstation(request, url, workstationId);
	}
	const serviceId = url.searchParams.get("service");
	if (!serviceId) {
		return deny("Unauthorized", 401);
	}

	const svc = await gatedService(serviceId);
	if (!svc) {
		return deny("Unauthorized", 401);
	}
	if (!svc.authRequired) {
		return new Response("OK", { status: 200 });
	}
	if (config.pangolinOwnsAuth) {
		return new Response("OK", { status: 200 });
	}

	const forwarded = readForwarded(request, url);

	if (forwarded.path === GATE_LOGOUT_PATH) {
		return redirect(forwarded.origin, gateCookie("", forwarded.secure, 0));
	}
	if (forwarded.path === GATE_CALLBACK_PATH) {
		return await handleCallback(svc, forwarded);
	}

	const cookie = readGateCookie(request.headers.get("cookie"));
	const payload = cookie ? verifyGateToken(cookie) : null;
	const currentPolicy = policyVersion(svc);
	if (
		payload?.userId &&
		payload.serviceId === svc.id &&
		payload.host === forwarded.host &&
		payload.policyVersion === currentPolicy &&
		(await stillAllowed(svc, payload.userId, currentPolicy))
	) {
		return new Response("OK", {
			headers: {
				"x-homerun-email": payload.email ?? "",
				"x-homerun-name": payload.name ?? "",
				"x-homerun-user": payload.userId,
			},
			status: 200,
		});
	}

	const kind = gateChallengeKind(request.headers, forwarded.path);
	if (kind === "allow") {
		return new Response("OK", { status: 200 });
	}
	if (kind === "deny") {
		return deny("Sign in to this app first.", 401);
	}
	return challenge(svc, forwarded);
};
