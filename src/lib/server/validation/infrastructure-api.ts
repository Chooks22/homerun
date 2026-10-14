import { z } from "zod";
import { isDomainName, isTarget } from "#lib/server/validation/dns-forms.js";
import type { WorkstationSettings } from "#lib/server/workstation-form.js";
import { DOMAIN_RE } from "#lib/service-domains.js";
import { DNS_RECORD_TYPES } from "#lib/services/dns-providers/types.js";
import {
	AUTO_STOP_MODES,
	DEFAULT_WORKSTATION_HOME,
	DEFAULT_WORKSTATION_IMAGE,
	DEFAULT_WORKSTATION_PORT,
	EXTENSION_ID_RE,
} from "#lib/workstations.js";

const text = z.string().trim();
const nullableText = text.nullable().optional();
const secret = (description: string) =>
	text.optional().describe(`${description} Write-only.`);

export const remoteHostApiBody = z.object({
	agentToken: secret(
		"The agent's bearer token (kind agent), checked against the agent before saving.",
	),
	agentUrl: text
		.optional()
		.describe("The agent's base URL (kind agent), e.g. http://10.0.0.5:7420."),
	dockerHost: text
		.optional()
		.describe(
			"The Docker daemon (kind docker): tcp://host:2376 or ssh://user@host.",
		),
	kind: z.enum(["docker", "agent"]).default("docker"),
	name: text.min(1).max(100),
	tlsCa: secret("TLS CA certificate (PEM) for a tcp:// daemon."),
	tlsCert: secret("TLS client certificate (PEM) for a tcp:// daemon."),
	tlsKey: secret("TLS client key (PEM) for a tcp:// daemon."),
});

export const updateRemoteHostApiBody = remoteHostApiBody
	.omit({ kind: true })
	.partial();

export const domainApiBody = z.object({
	autoRecords: z
		.boolean()
		.default(true)
		.describe(
			"Create and remove the records of services' hostnames under it automatically.",
		),
	connectionId: nullableText.describe(
		"The DNS connection the domain's zone lives in.",
	),
	name: text
		.toLowerCase()
		.refine(isDomainName, "Enter a domain name, like example.com."),
	target: nullableText
		.refine((value) => !value || isTarget(value), {
			message: "Point records at an IP address or a hostname.",
		})
		.describe(
			"What its services' records point at: an IP or a hostname. Unset points them at the base domain.",
		),
	zoneId: nullableText.describe(
		"The provider zone the domain lives in. Required with connectionId.",
	),
	zoneName: nullableText.describe(
		"The zone's name, looked up from the connection when left out.",
	),
});

export const updateDomainApiBody = domainApiBody
	.omit({ name: true })
	.extend({ autoRecords: z.boolean() })
	.partial();

export const dnsRecordApiBody = z.object({
	content: text.min(1).describe("The value: an address, a hostname or text."),
	name: text
		.min(1)
		.describe(
			"@ for the domain itself, a label under it, or a full name. Answered as the full name.",
		),
	priority: z
		.number()
		.int()
		.min(0)
		.max(65_535)
		.nullable()
		.optional()
		.describe("MX only, 10 when left out."),
	ttl: z
		.number()
		.int()
		.min(60)
		.max(86_400)
		.nullable()
		.optional()
		.describe("Seconds, automatic when left out."),
	type: z.enum(DNS_RECORD_TYPES),
});

export const updateDnsRecordApiBody = dnsRecordApiBody.partial();

/**
 * A record body as the dashboard's record form would send it, so the API
 * goes through the same `parseRecordForm` checks: the name made absolute,
 * the value checked against the type, the TTL and MX priority ranges.
 */
export function recordFormData(record: {
	content: string;
	name: string;
	priority?: number | null;
	ttl?: number | null;
	type: string;
}): FormData {
	const form = new FormData();
	form.set("content", record.content);
	form.set("name", record.name);
	form.set("priority", String(record.priority ?? ""));
	form.set("ttl", String(record.ttl ?? ""));
	form.set("type", record.type);
	return form;
}

const cpuLimit = z
	.union([
		z.number().positive("CPU limit must be above 0.").max(256),
		text
			.regex(/^\d+(\.\d+)?$/, "CPU limit is a number of cores, like 1.5.")
			.refine((value) => Number(value) > 0 && Number(value) <= 256, {
				message: "CPU limit must be above 0 and at most 256.",
			}),
	])
	.nullable()
	.optional()
	.describe("Cores, like 1.5. Answered as a string.");

const workstationSettingsShape = {
	cpuLimit,
	editorSettings: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("code-server settings.json, as an object."),
	env: z
		.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
		.optional()
		.describe(
			"Variables set in the container. PASSWORD is Homerun's and is dropped.",
		),
	extensions: z
		.array(
			text.regex(
				EXTENSION_ID_RE,
				"Extensions are publisher.name ids, like esbenp.prettier-vscode.",
			),
		)
		.max(100, "That's more than 100 extensions.")
		.optional()
		.describe("Open VSX extension ids installed on every start."),
	gitAuthorEmail: nullableText.refine(
		(value) => !value || z.email().safeParse(value).success,
		{ message: "The commit email isn't an email address." },
	),
	gitAuthorName: nullableText,
	gitBranch: nullableText.refine((value) => !value?.startsWith("-"), {
		message: "A branch name can't start with a dash.",
	}),
	gitProviderId: nullableText.describe(
		"The git provider whose connection signs in and authenticates git.",
	),
	gitUrl: nullableText
		.refine((value) => !value || /^https?:\/\/[^/\s]+\/\S+$/.test(value), {
			message: "The repository must be an http(s) clone URL.",
		})
		.describe("Cloned into the home directory on the first start."),
	homePath: text
		.refine((value) => value.startsWith("/") && !value.includes(":"), {
			message: "The home path must be an absolute path.",
		})
		.optional()
		.describe(`Defaults to ${DEFAULT_WORKSTATION_HOME}.`),
	image: text
		.min(1)
		.refine((value) => !/\s/.test(value), {
			message: "The image can't contain spaces.",
		})
		.optional()
		.describe(`Defaults to ${DEFAULT_WORKSTATION_IMAGE}.`),
	memoryLimitMb: z
		.number()
		.int("Memory must be whole megabytes.")
		.min(128)
		.max(1_048_576)
		.nullable()
		.optional(),
	port: z
		.number()
		.int()
		.min(1)
		.max(65_535)
		.optional()
		.describe(
			`The IDE's port in the container, ${DEFAULT_WORKSTATION_PORT} by default.`,
		),
	remoteHostId: nullableText.describe(
		"The agent host it runs on, this server when unset.",
	),
};

const workstationRuntimeShape = {
	autoStopMinutes: z
		.number()
		.int("The auto-stop delay must be whole minutes.")
		.min(5, "The auto-stop delay must be at least 5 minutes.")
		.max(10_080, "The auto-stop delay can't exceed a week.")
		.nullable()
		.optional(),
	autoStopMode: z
		.enum(AUTO_STOP_MODES)
		.nullable()
		.optional()
		.describe("idle or timer, unset for never. Needs autoStopMinutes."),
	desiredState: z
		.enum(["running", "stopped"])
		.optional()
		.describe(
			"running starts it, stopped stops it. A new one starts unless stopped.",
		),
	name: text.min(1, "Give the workstation a name.").max(80),
};

const workstationSettingsSchema = z.object(workstationSettingsShape);

/**
 * The workstation or preset columns a request body sets: blank text as
 * null, the CPU limit as a number, extension ids deduplicated in lower case
 * and PASSWORD dropped from the variables. Fields left out stay out.
 */
export function workstationColumns(
	body: Partial<z.infer<typeof workstationSettingsSchema>>,
): Partial<WorkstationSettings> & { remoteHostId?: string | null } {
	const blank = (value: string | null | undefined) =>
		value === undefined ? undefined : value?.trim() || null;
	const columns = {
		cpuLimit:
			body.cpuLimit === undefined || body.cpuLimit === null
				? body.cpuLimit
				: Number(body.cpuLimit),
		editorSettings: body.editorSettings,
		env:
			body.env &&
			Object.fromEntries(
				Object.entries(body.env).filter(([key]) => key !== "PASSWORD"),
			),
		extensions: body.extensions && [
			...new Set(body.extensions.map((id) => id.toLowerCase())),
		],
		gitAuthorEmail: blank(body.gitAuthorEmail),
		gitAuthorName: blank(body.gitAuthorName),
		gitBranch: blank(body.gitBranch),
		gitProviderId: blank(body.gitProviderId),
		gitUrl: blank(body.gitUrl),
		homePath: body.homePath,
		image: body.image,
		memoryLimitMb: body.memoryLimitMb,
		port: body.port,
		remoteHostId: blank(body.remoteHostId),
	};
	return Object.fromEntries(
		Object.entries(columns).filter(([, value]) => value !== undefined),
	);
}

export const workstationApiBody = z.object({
	...workstationSettingsShape,
	...workstationRuntimeShape,
	domain: text
		.toLowerCase()
		.nullable()
		.optional()
		.refine((value) => !value || DOMAIN_RE.test(value.replace(/\.$/, "")), {
			message: "The domain must be a hostname, like ide.example.com.",
		})
		.describe("Defaults to <slug>.dev.<base domain>. Can't change later."),
});

export const updateWorkstationApiBody = workstationApiBody
	.omit({ domain: true, remoteHostId: true })
	.partial();

export const workstationPresetApiBody = z.object({
	...workstationSettingsShape,
	description: nullableText.refine((value) => (value?.length ?? 0) <= 300, {
		message: "Keep the description under 300 characters.",
	}),
	name: text.min(1, "Give the preset a name.").max(80),
});

export const updateWorkstationPresetApiBody =
	workstationPresetApiBody.partial();
