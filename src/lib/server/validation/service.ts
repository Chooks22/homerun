import { z } from "zod";
import {
	BAKE_TARGET_PATTERN,
	BUILD_ARG_NAME_PATTERN,
	BUILD_METHODS,
} from "#lib/build-methods.js";
import {
	type PublishedPort,
	publishedPortsProblem,
} from "#lib/published-ports.js";
import {
	SCALE_TO_ZERO_MAX_MINUTES,
	SCALE_TO_ZERO_MIN_MINUTES,
} from "#lib/scale-to-zero.js";
import { environmentNameField } from "#lib/server/validation/environment-name.js";
import { isDomainEntry, normalizeDomain } from "#lib/service-domains.js";
import { isRunAsUser } from "#lib/service-runtime.js";
import { splitShellWords } from "#lib/shell-words.js";
import {
	normalizePlacementConstraint,
	normalizePlacementPreference,
	placementLines,
} from "#lib/swarm-placement.js";

// Optional numeric fields that come from a plain <input>: an empty field
// still submits as "" in FormData, and z.coerce.number() turns "" into 0
// (not NaN/undefined) : which then fails a .positive()/.min() check with
// no obvious cause. Treat "" as "not provided" before coercion.
const optionalNumber = (schema: z.ZodNumber | z.ZodCoercedNumber) =>
	z.preprocess(
		(val) => (val === "" || val === undefined ? undefined : val),
		schema.optional(),
	);

const formBoolean = () =>
	z
		.enum(["on", ""])
		.default("")
		.transform((val) => val === "on");

const buildTargetField = z
	.string()
	.trim()
	.refine(
		(value) => value === "" || BAKE_TARGET_PATTERN.test(value),
		"A build target is letters, digits, dashes and underscores.",
	)
	.optional();

const baseServiceSchema = z.object({
	// Checkbox convention (also used below): present ("on") when checked,
	// absent from FormData entirely when unchecked : never a literal
	// "false" to coerce.
	authRequired: z.preprocess(
		(val) => val === "on" || val === true,
		z.boolean(),
	),
	// "image" (bring-your-own, the default) | "git" (clone + build a
	// Dockerfile) : cross-checked against the other git*/image fields below,
	// since which of those is required depends on this.
	buildCacheRegistryId: z.string().optional(),
	buildServerRemoteHostId: z.string().optional(),
	buildSource: z.enum(["image", "git"]).default("image"),
	containerPort: z.coerce
		.number({ error: "Container port is required." })
		.int()
		.min(1)
		.max(65_535),
	cpuLimit: z.string().optional(),
	domain: z
		.string()
		.overwrite(normalizeDomain)
		.refine(
			(value) => value === "" || isDomainEntry(value),
			"That doesn't look like a domain name.",
		)
		.optional(),
	dnsResolvable: z.preprocess(
		(val) => val === "on" || val === true,
		z.boolean(),
	),
	autoDeployOnPush: z.preprocess(
		(val) => val === "on" || val === true,
		z.boolean(),
	),
	gitBakeFile: z.string().trim().optional(),
	gitBuildTarget: buildTargetField,
	gitBuildContext: z.string().optional(),
	gitBuildMethod: z.enum(BUILD_METHODS).default("dockerfile"),
	gitDockerfilePath: z.string().optional(),
	gitProviderId: z.string().optional(),
	gitRef: z.string().optional(),
	gitRepo: z.string().optional(),
	gitUrl: z.string().optional(),
	image: z.string().optional(),
	memoryLimitMb: optionalNumber(z.coerce.number().int().positive()),
	name: z.string().min(1, "Name is required.").max(100),
	// "bridge" (default, Traefik-routed on the shared network) | "host"
	// (shares the host's network namespace directly : mDNS/SSDP-dependent
	// apps like Home Assistant; forces dnsResolvable off server-side, see
	// networking/+page.server.ts's `updatePorts` action).
	networkMode: z.enum(["bridge", "host"]).default("bridge"),
	// Which protocol(s) containerPort is exposed under : see schema.ts's
	// `service.portProtocol` docstring for what this does and doesn't mean.
	portProtocol: z.enum(["tcp", "udp", "both"]).default("tcp"),
	registryPassword: z.string().optional(),
	registryUrl: z.string().optional(),
	registryUsername: z.string().optional(),
	// Swarm mode only (instanceSettings.orchestrationMode) : ignored entirely
	// in standalone mode.
	replicas: optionalNumber(z.coerce.number().int().min(0).max(50)),
	healthcheckCommand: z.string().trim().max(2000).optional(),
	pullPolicy: z.enum(["always", "missing", "never"]).default("always"),
	restartPolicy: z
		.enum(["no", "always", "on-failure", "unless-stopped"])
		.default("unless-stopped"),
	slug: z
		.string()
		.min(1, "Slug is required.")
		.regex(
			/^[a-z0-9-]{1,63}$/,
			"Lowercase letters, numbers, and hyphens only.",
		),
	tag: z.string().optional(),
});

/** buildSource-dependent required field, shared by createServiceSchema and updateSourceSchema below. */
function requireImageOrGitUrl(
	input: { buildSource: "image" | "git"; gitUrl?: string; image?: string },
	ctx: z.RefinementCtx,
) {
	if (input.buildSource === "git") {
		if (!input.gitUrl) {
			ctx.addIssue({
				code: "custom",
				message: "Git repository URL is required.",
				path: ["gitUrl"],
			});
		}
		return;
	}
	if (!input.image) {
		ctx.addIssue({
			code: "custom",
			message: "Image is required.",
			path: ["image"],
		});
	}
}

export const createServiceSchema =
	baseServiceSchema.superRefine(requireImageOrGitUrl);

export type CreateServiceInput = z.infer<typeof createServiceSchema>;

// The existing-service Settings tab is split across independent forms/
// actions/routes (Settings for the fields below, Source for build/image/git/
// registry : see services/[serviceId]/environments/source/, Networking's own "Network"
// section for port/protocol/network-mode/DNS : see updatePortsSchema below),
// each validated against only its own subset of baseServiceSchema rather
// than the full create-time shape.
export const updateGeneralSchema = baseServiceSchema
	.pick({
		name: true,
		pullPolicy: true,
		restartPolicy: true,
		slug: true,
	})
	.extend({ environmentName: environmentNameField.optional() });
export type UpdateGeneralInput = z.infer<typeof updateGeneralSchema>;

const healthSeconds = optionalNumber(z.coerce.number().int().min(1).max(3600));

export const updateHealthSchema = z.object({
	healthcheckCommand: z.string().trim().max(2000).optional(),
	healthcheckDisabled: z.preprocess(
		(val) => val === "on" || val === true,
		z.boolean(),
	),
	healthcheckIntervalSeconds: healthSeconds,
	healthcheckRetries: optionalNumber(z.coerce.number().int().min(1).max(100)),
	healthcheckStartPeriodSeconds: optionalNumber(
		z.coerce.number().int().min(0).max(3600),
	),
	healthcheckTimeoutSeconds: healthSeconds,
});

// Backs the Compute tab : cpu/memory limits and swarm replica count.
export const updateComputeSchema = baseServiceSchema
	.pick({
		cpuLimit: true,
		memoryLimitMb: true,
		replicas: true,
	})
	.extend({
		scaleToZeroEnabled: formBoolean(),
		scaleToZeroMinutes: optionalNumber(
			z.coerce
				.number()
				.int()
				.min(SCALE_TO_ZERO_MIN_MINUTES)
				.max(SCALE_TO_ZERO_MAX_MINUTES),
		),
		placementConstraints: z.string().optional(),
		placementManager: formBoolean(),
		placementPreferences: z.string().optional(),
		placementWorker: formBoolean(),
	})
	.transform(
		(
			{
				placementConstraints,
				placementManager,
				placementPreferences,
				placementWorker,
				...input
			},
			ctx,
		) => {
			if (placementConstraints === undefined) {
				return { ...input, swarmPlacement: undefined };
			}
			const roles = [
				...(placementManager ? (["manager"] as const) : []),
				...(placementWorker ? (["worker"] as const) : []),
			];
			if (roles.length === 0) {
				ctx.addIssue({
					code: "custom",
					message: "Pick at least one node role.",
					path: ["placementRoles"],
				});
			}
			const constraints: string[] = [];
			for (const line of placementLines(placementConstraints)) {
				const constraint = normalizePlacementConstraint(line);
				if (!constraint) {
					ctx.addIssue({
						code: "custom",
						message: `"${line}" isn't a key==value or key!=value constraint.`,
						path: ["placementConstraints"],
					});
					continue;
				}
				constraints.push(constraint);
			}
			const preferences: string[] = [];
			for (const line of placementLines(placementPreferences ?? "")) {
				const key = normalizePlacementPreference(line);
				if (!key) {
					ctx.addIssue({
						code: "custom",
						message: `"${line}" isn't a node label key.`,
						path: ["placementPreferences"],
					});
					continue;
				}
				preferences.push(key);
			}
			return {
				...input,
				swarmPlacement: { constraints, preferences, roles },
			};
		},
	);
export type UpdateComputeInput = z.infer<typeof updateComputeSchema>;

// Backs the Networking tab's "Network" section : container port, which
// protocol(s) it's exposed under, network mode (bridge/host), and
// DNS-resolvability all live together here since they're all "how this
// container attaches to the network" in one way or another (moved off the
// old Settings tab, which used to own containerPort/dnsResolvable).
export const updatePortsSchema = baseServiceSchema.pick({
	containerPort: true,
	dnsResolvable: true,
	networkMode: true,
	portProtocol: true,
});
export type UpdatePortsInput = z.infer<typeof updatePortsSchema>;

// registryPassword is optional here too: blank means "leave the stored
// credential unchanged", not "clear it" (see source/+page.server.ts).
export const updateSourceSchema = baseServiceSchema
	.pick({
		autoDeployOnPush: true,
		buildCacheRegistryId: true,
		buildServerRemoteHostId: true,
		buildSource: true,
		gitBakeFile: true,
		gitBuildTarget: true,
		gitBuildContext: true,
		gitBuildMethod: true,
		gitDockerfilePath: true,
		gitProviderId: true,
		gitRef: true,
		gitRepo: true,
		gitUrl: true,
		image: true,
		registryPassword: true,
		registryUrl: true,
		registryUsername: true,
		tag: true,
	})
	.superRefine(requireImageOrGitUrl);
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;

/**
 * Zips parallel envKey[]/envValue[]/envKeep[] form fields into a record,
 * dropping blank keys. A row posted with no value and the name a secret was
 * stored under in `envKeep` (a secret the user left untouched, which the env
 * editor never puts in the page) keeps that var's value from `stored`.
 */
export function parseEnvVars(
	formData: FormData,
	stored: Record<string, string> = {},
): Record<string, string> {
	const keys = formData.getAll("envKey").map(String);
	const values = formData.getAll("envValue").map(String);
	const keeps = formData.getAll("envKeep").map(String);
	const env: Record<string, string> = {};
	keys.forEach((key, i) => {
		const trimmed = key.trim();
		if (!trimmed) {
			return;
		}
		const value = values[i] ?? "";
		const keep = keeps[i];
		env[trimmed] =
			value === "" && keep && Object.hasOwn(stored, keep)
				? (stored[keep] ?? "")
				: value;
	});
	return env;
}

/** The env var names an env editor marked secret (its `envSecret` fields), deduplicated and limited to the vars it saved. */
export function parseSecretEnvKeys(
	formData: FormData,
	envVars: Record<string, string>,
): string[] {
	return [...new Set(formData.getAll("envSecret").map(String))].filter(
		(key) => key in envVars,
	);
}

/**
 * The env var names an env editor marked build-time (its `envBuild` fields),
 * deduplicated and limited to the vars it saved.
 *
 * @throws When a marked name isn't a shell identifier, which a build arg's
 *   name has to be.
 */
export function parseBuildEnvKeys(
	formData: FormData,
	envVars: Record<string, string>,
): string[] {
	const keys = [...new Set(formData.getAll("envBuild").map(String))].filter(
		(key) => key in envVars,
	);
	const invalid = keys.find((key) => !BUILD_ARG_NAME_PATTERN.test(key));
	if (invalid) {
		throw new Error(
			`${invalid} can't be a build-time variable: use letters, digits and underscores, not starting with a digit.`,
		);
	}
	return keys;
}

/** Splits a textarea into its trimmed, non-blank lines. */
function nonBlankLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

const CAPABILITY_RE = /^(CAP_)?[A-Z_]+$/i;
const LABEL_KEY_RE = /^[A-Za-z0-9][\w.-]*$/;

/**
 * Backs the Runtime tab : command and entrypoint as shell-style command
 * lines, labels as `KEY=VALUE` lines, capabilities separated by commas or
 * spaces, devices one per line, privileged as a checkbox and the run-as user
 * as `uid[:gid]` or `name[:group]` (blank keeps the image's). Parsed into the
 * stored shapes (argv lists, a label map, string lists).
 */
export const updateRuntimeSchema = z
	.object({
		capAdd: z.string().default(""),
		command: z.string().trim().max(4000).default(""),
		devices: z.string().default(""),
		entrypoint: z.string().trim().max(4000).default(""),
		labels: z.string().default(""),
		privileged: z.preprocess(
			(val) => val === "on" || val === true,
			z.boolean(),
		),
		runAsUser: z
			.string()
			.trim()
			.default("")
			.refine((value) => !value || isRunAsUser(value), {
				message: "Use uid, uid:gid, name or name:group.",
			}),
	})
	.transform((input, ctx) => {
		const capAdd = input.capAdd
			.split(/[\s,]+/)
			.map((cap) => cap.trim())
			.filter(Boolean);
		const badCap = capAdd.find((cap) => !CAPABILITY_RE.test(cap));
		if (badCap) {
			ctx.addIssue({
				code: "custom",
				message: `"${badCap}" isn't a capability name.`,
				path: ["capAdd"],
			});
		}
		const labels: Record<string, string> = {};
		for (const line of nonBlankLines(input.labels)) {
			const eq = line.indexOf("=");
			const key = eq > 0 ? line.slice(0, eq).trim() : "";
			if (!LABEL_KEY_RE.test(key)) {
				ctx.addIssue({
					code: "custom",
					message: `"${line}" isn't a KEY=VALUE label.`,
					path: ["labels"],
				});
				continue;
			}
			labels[key] = line.slice(eq + 1).trim();
		}
		const command = splitShellWords(input.command);
		const entrypoint = splitShellWords(input.entrypoint);
		return {
			capAdd: capAdd.map((cap) => cap.toUpperCase()),
			command: command.length > 0 ? command : null,
			devices: nonBlankLines(input.devices),
			entrypoint: entrypoint.length > 0 ? entrypoint : null,
			labels,
			privileged: input.privileged,
			runAsUser: input.runAsUser || null,
		};
	});
export type UpdateRuntimeInput = z.infer<typeof updateRuntimeSchema>;

/** Backs the Environment Variables section's env files form : absolute host paths, one per line. */
export const updateEnvFilesSchema = z.object({
	envFiles: z
		.string()
		.default("")
		.transform(nonBlankLines)
		.pipe(
			z.array(
				z
					.string()
					.max(1000)
					.regex(/^\//, "Env file paths must be absolute host paths."),
			),
		),
});

const portNumber = z.number().int().min(1).max(65_535);

/** The Networking tab's published ports, posted as one JSON array. */
export const publishedPortsSchema = z.array(
	z.object({
		containerPort: portNumber,
		hostPort: portNumber,
		protocol: z.enum(["tcp", "udp"]),
	}),
);

/**
 * Reads a published ports list posted as one JSON array form field, empty
 * when the field is missing, or the first problem with it: unreadable JSON,
 * a port outside 1-65535, a reused host port or one of Traefik's.
 */
export function parsePublishedPortsField(
	value: FormDataEntryValue | null,
): { ports: PublishedPort[] } | { error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(String(value ?? "[]"));
	} catch {
		return { error: "Couldn't read the port list." };
	}
	const result = publishedPortsSchema.safeParse(raw);
	if (!result.success) {
		return { error: "Every port must be a number between 1 and 65535." };
	}
	const problem = publishedPortsProblem(result.data);
	return problem ? { error: problem } : { ports: result.data };
}
