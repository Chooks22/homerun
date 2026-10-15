import { z } from "zod";
import { ERROR_PAGE_KINDS } from "#lib/error-pages.js";
import { SCAN_SEVERITIES } from "#lib/image-scan.js";
import { UI_MODES } from "#lib/ui-mode.js";
import { UPDATE_CHANNELS } from "#lib/update-channel.js";

const text = z.string().trim();
const nullableText = text.nullable().optional();
const nullableBool = z.boolean().nullable().optional();
const whole = z.number().int().optional();
const secret = (description: string) =>
	z.string().trim().min(1).optional().describe(`${description} Write-only.`);

export const ERROR_PAGE_TEXT_KEYS = ERROR_PAGE_KINDS.flatMap(({ kind }) => [
	`${kind}Title`,
	`${kind}Message`,
]);

const percent = whole.describe("A usage percentage that alerts, 1 to 100.");

export const instanceSettingsApiBody = z.object({
	authCheckUrl: nullableText.describe(
		"The URL the login wall checks sessions against. Null uses the default.",
	),
	authCrossSubdomainCookies: nullableBool.describe(
		"Share the session cookie with every subdomain of the base domain.",
	),
	baseDomain: nullableText.describe(
		"Services get <slug>.<baseDomain>. A bare hostname.",
	),
	serviceSubdomain: nullableText.describe(
		"One DNS label services' default hostnames go under, <slug>.<serviceSubdomain>.<baseDomain>, like workstations under dev. Null keeps <slug>.<baseDomain>.",
	),
	dashboardUrl: nullableText.describe(
		"The dashboard's URL. Null derives it from the base domain, over https unless it was http before.",
	),
	defaultUiMode: z.enum(UI_MODES).optional(),
	cpuHardThreshold: percent,
	cpuSoftThreshold: percent,
	diskHardThreshold: percent,
	diskSoftThreshold: percent,
	dockerNetworkName: nullableText,
	dockerSocketPath: nullableText,
	gpuHardThreshold: percent,
	gpuSoftThreshold: percent,
	imageScanBlockFixableOnly: z.boolean().optional(),
	imageScanBlockSeverity: z
		.enum(SCAN_SEVERITIES)
		.exclude(["UNKNOWN"])
		.nullable()
		.optional()
		.describe(
			"Refuse to deploy an image with a finding this severe or worse. Null blocks nothing.",
		),
	imageScanEnabled: z.boolean().optional(),
	imageScanRequired: z.boolean().optional(),
	memoryHardThreshold: percent,
	memorySoftThreshold: percent,
	orchestrationMode: z
		.enum(["standalone", "swarm"])
		.optional()
		.describe(
			"Changing it prepares the host (joins or leaves swarm mode) before saving.",
		),
	resourceAlertReminderMinutes: whole.describe(
		"Minutes between reminders while a resource stays past a limit, 0 to 1440, 0 for none.",
	),
	resourceAlertSustainSeconds: whole.describe(
		"Seconds a resource has to stay past a limit before it alerts, 0 to 3600.",
	),
	retainedImagesPerService: whole,
	traefikAcmeEmail: nullableText,
	traefikCertResolver: nullableText,
	traefikDynamicConfigDir: nullableText,
	traefikEntrypoint: nullableText,
	traefikHttpCache: z.boolean().optional(),
	updateChannel: z.enum(UPDATE_CHANNELS).optional(),
});

export const smtpSettingsApiBody = z.object({
	enabled: nullableBool,
	from: nullableText.describe("The sender address."),
	host: nullableText,
	password: secret("The SMTP password. Left out, the stored one stays."),
	port: z.number().int().min(1).max(65_535).nullable().optional(),
	secure: nullableBool.describe("Implicit TLS (port 465)."),
	username: nullableText,
});

export const authenticationSettingsApiBody = z.object({
	emailOtp: z
		.boolean()
		.optional()
		.describe("Sign in with a code sent by email. Needs SMTP."),
	magicLink: z
		.boolean()
		.optional()
		.describe("Sign in with a link sent by email. Needs SMTP."),
	preferredSignInMethods: z
		.array(text.min(1))
		.optional()
		.describe(
			"The sign-in methods the sign-in page features, in order: password, passkey or oauth:<provider>.",
		),
	requirePasskey: z.boolean().optional(),
	requireTwoFactor: z.boolean().optional(),
});

export const tlsSettingsApiBody = z.object({
	certificate: text
		.min(1)
		.nullable()
		.optional()
		.describe(
			"The certificate PEM, chain included. Null, or a null privateKey, removes the installed certificate. Write-only.",
		),
	privateKey: text
		.min(1)
		.nullable()
		.optional()
		.describe("The private key PEM. Write-only."),
});

export const errorPagesApiBody = z.object({
	accentColor: text.max(7).nullable().optional().describe("Like #8b2942."),
	brandName: text.min(1).max(60).optional(),
	logoUrl: text.max(2000).nullable().optional(),
	pageTexts: z
		.partialRecord(z.enum(ERROR_PAGE_TEXT_KEYS), text.max(400))
		.optional()
		.describe(
			"Each page's title and message (notReadyTitle, notReadyMessage, unavailable..., waking..., notFound..., blocked...). One left out or blank shows the default.",
		),
	showPoweredBy: z.boolean().optional(),
});

export const ipBanSettingsApiBody = z.object({
	crowdsecMachineId: nullableText,
	crowdsecPassword: secret(
		"The CrowdSec machine password. Left out, the stored one stays.",
	),
	crowdsecUrl: nullableText.describe(
		"The CrowdSec LAPI bans are pushed to. Null turns the push off.",
	),
	disrespectMode: z.boolean().optional(),
	durationHours: whole.describe("How long a ban lasts, 0 (forever) to 8760."),
	enabled: z.boolean().optional(),
	meanMode: z.boolean().optional(),
	threshold: whole.describe("Blocked requests before a ban, 1 to 1000."),
	windowMinutes: whole.describe(
		"The window the blocked requests are counted over.",
	),
});

export const registrySettingsApiBody = z.object({
	authEnabled: z
		.boolean()
		.optional()
		.describe("Require a token to push or pull."),
	publicHost: text
		.toLowerCase()
		.nullable()
		.optional()
		.describe(
			"Publish the registry at this hostname through Traefik. Needs authEnabled. Null unpublishes it.",
		),
});

export const registryTokenApiBody = z.object({
	username: text
		.toLowerCase()
		.min(1)
		.describe("3 to 32 lowercase letters, digits, dashes or underscores."),
});
