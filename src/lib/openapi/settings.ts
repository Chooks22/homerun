import { z } from "zod";
import { SCAN_SEVERITIES } from "#lib/image-scan.js";
import {
	authenticationSettingsApiBody,
	errorPagesApiBody,
	instanceSettingsApiBody,
	ipBanSettingsApiBody,
	registrySettingsApiBody,
	registryTokenApiBody,
	smtpSettingsApiBody,
	tlsSettingsApiBody,
} from "#lib/server/validation/settings-api.js";
import { UI_MODES } from "#lib/ui-mode.js";
import { UPDATE_CHANNELS } from "#lib/update-channel.js";
import type { ParamDef, ResponseDef, RouteDef } from "./registry";
import { errorResponse } from "./schemas";

const timestamp = z.string().meta({ description: "ISO 8601 timestamp" });
const nullableText = z.string().nullable();
const percent = z.number().int();

const unauthorized: ResponseDef = {
	description: "Unauthorized",
	schema: errorResponse,
};
const refused: ResponseDef = {
	description: "Invalid body, or a value the instance refuses",
	schema: errorResponse,
};
const unreachable: ResponseDef = {
	description: "The registry isn't answering",
	schema: errorResponse,
};
const failed: ResponseDef = {
	description: "Saved up to the step that failed, with the reason",
	schema: errorResponse,
};

export const instanceSettingsResponse = z.object({
	authCheckUrl: nullableText,
	authCrossSubdomainCookies: z.boolean().nullable(),
	baseDomain: nullableText,
	serviceSubdomain: nullableText,
	cpuHardThreshold: percent,
	cpuSoftThreshold: percent,
	dashboardUrl: nullableText,
	defaultUiMode: z.enum(UI_MODES),
	diskHardThreshold: percent,
	diskSoftThreshold: percent,
	dockerNetworkName: nullableText,
	dockerSocketPath: nullableText,
	gpuHardThreshold: percent,
	gpuSoftThreshold: percent,
	imageScanBlockFixableOnly: z.boolean(),
	imageScanBlockSeverity: z
		.enum(SCAN_SEVERITIES)
		.exclude(["UNKNOWN"])
		.nullable(),
	imageScanEnabled: z.boolean(),
	imageScanRequired: z.boolean(),
	memoryHardThreshold: percent,
	memorySoftThreshold: percent,
	orchestrationMode: z.enum(["standalone", "swarm"]),
	resourceAlertReminderMinutes: z.number().int(),
	resourceAlertSustainSeconds: z.number().int(),
	retainedImagesPerService: z.number().int(),
	traefikAcmeEmail: nullableText,
	traefikCertResolver: nullableText,
	traefikDynamicConfigDir: nullableText,
	traefikEntrypoint: nullableText,
	traefikHttpCache: z.boolean(),
	updateChannel: z.enum(UPDATE_CHANNELS),
});

export const smtpSettingsResponse = z.object({
	enabled: z.boolean().nullable(),
	from: nullableText,
	host: nullableText,
	passwordSet: z.boolean(),
	port: z.number().int().nullable(),
	secure: z.boolean().nullable(),
	username: nullableText,
});

export const authenticationSettingsResponse = z.object({
	emailOtp: z.boolean(),
	magicLink: z.boolean(),
	preferredSignInMethods: z.array(z.string()),
	requirePasskey: z.boolean(),
	requireTwoFactor: z.boolean(),
	smtpConfigured: z.boolean().meta({
		description: "Whether SMTP is set up, which both emailed methods need",
	}),
});

export const tlsSettingsResponse = z.object({
	expiresAt: timestamp.nullable(),
	installed: z.boolean(),
	issuer: nullableText,
	names: z.array(z.string()),
});

export const errorPagesResponse = z.object({
	accentColor: nullableText,
	brandName: z.string(),
	logoUrl: nullableText,
	pageTexts: z.record(z.string(), z.string()).meta({
		description: "The titles and messages set; one left out shows the default",
	}),
	showPoweredBy: z.boolean(),
});

export const ipBanSettingsResponse = z.object({
	crowdsecMachineId: nullableText,
	crowdsecPasswordSet: z.boolean(),
	crowdsecUrl: nullableText,
	disrespectMode: z.boolean(),
	durationHours: z.number().int(),
	enabled: z.boolean(),
	meanMode: z.boolean(),
	threshold: z.number().int(),
	windowMinutes: z.number().int(),
});

export const registrySettingsResponse = z.object({
	authEnabled: z.boolean(),
	publicHost: nullableText,
});

export const registryTokenResponse = z.object({
	createdAt: timestamp,
	id: z.string(),
	lastUsedAt: timestamp.nullable(),
	username: z.string(),
});

export const registryTagResponse = z.object({
	digest: z
		.string()
		.nullable()
		.meta({ description: "The manifest digest the tag points at" }),
	tag: z.string(),
});

export const registryRepositoryResponse = z.object({
	repository: z.string(),
	tags: z.array(registryTagResponse),
	usedBy: z.array(z.object({ id: z.string(), name: z.string() })).meta({
		description: "The services whose image lives in this repository",
	}),
});

interface SingletonSpec {
	body: z.ZodType;
	/** What the PATCH does beyond saving the fields sent. */
	note: string;
	path: string;
	response: z.ZodType;
	tag: string;
	title: string;
}

/** The GET and PATCH of one settings singleton. */
function singletonRoutes(spec: SingletonSpec): RouteDef[] {
	return [
		{
			method: "get",
			path: spec.path,
			responses: {
				200: { description: `The ${spec.title}`, schema: spec.response },
				401: unauthorized,
			},
			summary: `Get the ${spec.title}`,
			tags: [spec.tag],
		},
		{
			description: `Changes the fields sent and keeps the rest. ${spec.note}`,
			method: "patch",
			path: spec.path,
			requestBody: spec.body,
			responses: {
				200: { description: "Updated", schema: spec.response },
				400: refused,
				401: unauthorized,
				500: failed,
			},
			summary: `Update the ${spec.title}`,
			tags: [spec.tag],
		},
	];
}

const tokenIdParam: ParamDef[] = [
	{ description: "Registry token id", name: "tokenId" },
];

export const settingsRoutes: RouteDef[] = [
	...singletonRoutes({
		body: instanceSettingsApiBody,
		note: "Same checks and side effects as Settings → General, Docker and Networking: the live config, auth and Traefik follow, and a changed orchestration mode prepares the host first.",
		path: "/instance/settings",
		response: instanceSettingsResponse,
		tag: "Settings",
		title: "instance settings",
	}),
	...singletonRoutes({
		body: smtpSettingsApiBody,
		note: "The password is write-only: left out, the stored one stays.",
		path: "/instance/smtp",
		response: smtpSettingsResponse,
		tag: "Settings",
		title: "SMTP settings",
	}),
	...singletonRoutes({
		body: tlsSettingsApiBody,
		note: "A certificate and key are checked, written where Traefik reads them, then saved; send one alone to pair it with the installed other half. A null certificate or key removes the installed one.",
		path: "/instance/tls",
		response: tlsSettingsResponse,
		tag: "Settings",
		title: "instance certificate",
	}),
	...singletonRoutes({
		body: errorPagesApiBody,
		note: "pageTexts replaces every page's text: a page left out shows its default.",
		path: "/instance/error-pages",
		response: errorPagesResponse,
		tag: "Settings",
		title: "error pages",
	}),
	...singletonRoutes({
		body: ipBanSettingsApiBody,
		note: "A CrowdSec LAPI is logged in to before it's saved; a null crowdsecUrl turns the push off.",
		path: "/instance/ip-bans",
		response: ipBanSettingsResponse,
		tag: "Settings",
		title: "IP ban settings",
	}),
	...singletonRoutes({
		body: authenticationSettingsApiBody,
		note: "Same as the Authentication page's switches. A login wall offers email-otp only with emailOtp on and SMTP configured.",
		path: "/authentication/settings",
		response: authenticationSettingsResponse,
		tag: "Authentication",
		title: "authentication settings",
	}),
	...singletonRoutes({
		body: registrySettingsApiBody,
		note: "Each change is a queued job recreating the registry container, and the request waits for it: auth goes on before the registry is published, off after it's unpublished.",
		path: "/registry/settings",
		response: registrySettingsResponse,
		tag: "Registry",
		title: "registry settings",
	}),
	{
		method: "get",
		path: "/registry/tokens",
		responses: {
			200: {
				description: "The tokens, newest first",
				isArray: true,
				schema: registryTokenResponse,
			},
			401: unauthorized,
		},
		summary: "List registry tokens",
		tags: ["Registry"],
	},
	{
		description:
			"Creates a push and pull token for the built-in registry. Its secret is only ever returned here.",
		method: "post",
		path: "/registry/tokens",
		requestBody: registryTokenApiBody,
		responses: {
			201: {
				description: "Created",
				schema: registryTokenResponse.extend({
					secret: z.string().meta({
						description:
							"The docker login password. It's only ever returned here, store it now.",
					}),
				}),
			},
			400: refused,
			401: unauthorized,
		},
		summary: "Create a registry token",
		tags: ["Registry"],
	},
	{
		method: "get",
		path: "/registry/tokens/{tokenId}",
		pathParams: tokenIdParam,
		responses: {
			200: { description: "The token", schema: registryTokenResponse },
			401: unauthorized,
			404: { description: "Not found", schema: errorResponse },
		},
		summary: "Get a registry token",
		tags: ["Registry"],
	},
	{
		description: "Revokes the token: the registry stops accepting it.",
		method: "delete",
		path: "/registry/tokens/{tokenId}",
		pathParams: tokenIdParam,
		responses: {
			204: { description: "Revoked" },
			401: unauthorized,
			404: { description: "Not found", schema: errorResponse },
		},
		summary: "Revoke a registry token",
		tags: ["Registry"],
	},
	{
		description:
			"The built-in registry's repositories in name order, each with its tags, their digests and the services whose image lives in it.",
		method: "get",
		path: "/registry/repositories",
		queryParams: [
			{ description: "1-based page number (default 1)", name: "page" },
			{ description: "Items per page (default 100, max 100)", name: "perPage" },
			{ description: "Only repositories whose name contains this", name: "q" },
		],
		responses: {
			200: {
				description: "One page of repositories",
				isArray: true,
				schema: registryRepositoryResponse,
			},
			401: unauthorized,
			503: unreachable,
		},
		summary: "List registry repositories",
		tags: ["Registry"],
	},
	{
		method: "get",
		path: "/registry/repositories/{repository}/tags",
		pathParams: [
			{
				description: "Repository name, slashes included (team/app)",
				name: "repository",
			},
		],
		responses: {
			200: {
				description: "The repository's tags",
				isArray: true,
				schema: registryTagResponse,
			},
			400: {
				description: "Not a valid repository name",
				schema: errorResponse,
			},
			401: unauthorized,
			404: { description: "No tag in that repository", schema: errorResponse },
			503: unreachable,
		},
		summary: "List a registry repository's tags",
		tags: ["Registry"],
	},
];
