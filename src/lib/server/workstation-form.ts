import { z } from "zod";
import { parseDotEnv } from "#lib/env-parse.js";
import {
	type LoginWallPolicy,
	loginWallFromForm,
} from "#lib/server/login-wall-form.js";
import { DOMAIN_RE } from "#lib/service-domains.js";
import {
	AUTO_STOP_MODES,
	type AutoStopMode,
	DEFAULT_WORKSTATION_HOME,
	DEFAULT_WORKSTATION_IMAGE,
	DEFAULT_WORKSTATION_PORT,
	EXTENSION_ID_RE,
} from "#lib/workstations.js";

const optionalText = z
	.string()
	.nullish()
	.transform((value) => value?.trim() || null);

const optionalNumber = (schema: z.ZodNumber) =>
	z
		.string()
		.trim()
		.nullish()
		.transform((value) => (value ? Number(value) : null))
		.pipe(schema.nullable());

/** `text` parsed as a JSON object; null when it isn't valid JSON or isn't an object. */
function jsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

const repositorySchema = z.object({
	gitBranch: optionalText.refine((value) => !value?.startsWith("-"), {
		message: "A branch name can't start with a dash.",
	}),
	gitUrl: optionalText.refine(
		(value) => !value || /^https?:\/\/[^/\s]+\/\S+$/.test(value),
		{ message: "The repository must be an http(s) clone URL." },
	),
});

const containerSchema = z.object({
	cpuLimit: optionalNumber(
		z.number().positive("CPU limit must be above 0.").max(256),
	),
	env: z.string().nullish(),
	homePath: z
		.string()
		.trim()
		.nullish()
		.transform((value) => value || DEFAULT_WORKSTATION_HOME)
		.refine((value) => value.startsWith("/") && !value.includes(":"), {
			message: "The home path must be an absolute path.",
		}),
	image: z
		.string()
		.trim()
		.nullish()
		.transform((value) => value || DEFAULT_WORKSTATION_IMAGE)
		.refine((value) => !/\s/.test(value), {
			message: "The image can't contain spaces.",
		}),
	memoryLimitMb: optionalNumber(
		z.number().int("Memory must be whole megabytes.").min(128).max(1_048_576),
	),
	port: z
		.string()
		.trim()
		.nullish()
		.transform((value) => (value ? Number(value) : DEFAULT_WORKSTATION_PORT))
		.pipe(z.number().int().min(1).max(65_535)),
});

const editorSchema = z.object({
	editorSettings: z
		.string()
		.nullish()
		.transform((value, ctx) => {
			const text = value?.trim();
			if (!text) {
				return {};
			}
			const parsed = jsonObject(text);
			if (!parsed) {
				ctx.addIssue({
					code: "custom",
					message: "The editor settings must be a JSON object.",
				});
				return z.NEVER;
			}
			return parsed;
		}),
	extensions: z
		.array(
			z
				.string()
				.trim()
				.regex(
					EXTENSION_ID_RE,
					"Extensions are publisher.name ids, like esbenp.prettier-vscode.",
				),
		)
		.max(100, "That's more than 100 extensions.")
		.transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
});

const gitSchema = z.object({
	gitAuthorEmail: optionalText.refine(
		(value) => !value || z.email().safeParse(value).success,
		{ message: "The commit email isn't an email address." },
	),
	gitAuthorName: optionalText,
	gitProviderId: optionalText,
});

const settingsShape = {
	...repositorySchema.shape,
	...containerSchema.shape,
	...editorSchema.shape,
	...gitSchema.shape,
	remoteHostId: optionalText,
};

const newWorkstationSchema = z.object({
	...settingsShape,
	domain: optionalText
		.transform((value) => value?.toLowerCase().replace(/\.$/, "") ?? null)
		.refine((value) => !value || DOMAIN_RE.test(value), {
			message: "The domain must be a hostname, like ide.example.com.",
		}),
	name: z.string().trim().min(1, "Give the workstation a name.").max(80),
});

const presetSchema = z.object({
	...settingsShape,
	description: optionalText.refine((value) => (value?.length ?? 0) <= 300, {
		message: "Keep the description under 300 characters.",
	}),
	name: z.string().trim().min(1, "Give the preset a name.").max(80),
});

export const WORKSTATION_SECTIONS = [
	"repository",
	"container",
	"editor",
	"git",
] as const;

export type WorkstationSection = (typeof WORKSTATION_SECTIONS)[number];

/** A workstation's editable settings, normalised into DTO-ready columns. */
export interface WorkstationSettings {
	cpuLimit: number | null;
	editorSettings: Record<string, unknown>;
	env: Record<string, string>;
	extensions: string[];
	gitAuthorEmail: string | null;
	gitAuthorName: string | null;
	gitBranch: string | null;
	gitProviderId: string | null;
	gitUrl: string | null;
	homePath: string;
	image: string;
	memoryLimitMb: number | null;
	port: number;
}

/** The settings and login wall plus what only the create form picks. */
export interface NewWorkstationForm
	extends WorkstationSettings,
		LoginWallPolicy {
	domain: string | null;
	name: string;
	remoteHostId: string | null;
}

/** A preset's fields and login wall, normalised into DTO-ready columns. */
export interface WorkstationPresetForm
	extends WorkstationSettings,
		LoginWallPolicy {
	description: string | null;
	name: string;
	remoteHostId: string | null;
}

/** The first problem zod found, as one message. */
function firstIssue(error: z.ZodError): string {
	return error.issues[0]?.message ?? "Check the form for errors.";
}

/** The env textarea's `KEY=value` lines as a record; `PASSWORD` is Homerun's to set. */
function envFrom(text: string | null | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const row of parseDotEnv(text ?? "")) {
		if (row.key && row.key !== "PASSWORD") {
			env[row.key] = row.value;
		}
	}
	return env;
}

/** The form's fields, with `extensions` kept as every value it was sent. */
function fieldsOf(formData: FormData): Record<string, unknown> {
	return {
		...Object.fromEntries(formData),
		extensions: formData.getAll("extensions").map(String),
	};
}

/**
 * Validates one section of the Settings tab, each saved on its own.
 *
 * @returns Only that section's columns, or the first validation error message.
 */
export function parseWorkstationSection(
	section: WorkstationSection,
	formData: FormData,
): { error: string } | { parsed: Partial<WorkstationSettings> } {
	const fields = fieldsOf(formData);
	const result = {
		container: containerSchema,
		editor: editorSchema,
		git: gitSchema,
		repository: repositorySchema,
	}[section].safeParse(fields);
	if (!result.success) {
		return { error: firstIssue(result.error) };
	}
	if (section === "container") {
		const data = result.data as z.infer<typeof containerSchema>;
		return { parsed: { ...data, env: envFrom(data.env) } };
	}
	return { parsed: result.data as Partial<WorkstationSettings> };
}

/**
 * Validates the new-workstation form. Its login wall is only read here; the
 * settings service checks it against the instance's sign-in methods.
 *
 * @returns The parsed fields, or the first validation error message.
 */
export function parseNewWorkstation(
	formData: FormData,
): { error: string } | { parsed: NewWorkstationForm } {
	const result = newWorkstationSchema.safeParse(fieldsOf(formData));
	if (!result.success) {
		return { error: firstIssue(result.error) };
	}
	return {
		parsed: {
			...result.data,
			...loginWallFromForm(formData),
			env: envFrom(result.data.env),
		},
	};
}

/**
 * Validates the preset form, the same fields as a new workstation plus a
 * description.
 *
 * @returns The parsed fields, or the first validation error message.
 */
export function parseWorkstationPreset(
	formData: FormData,
): { error: string } | { parsed: WorkstationPresetForm } {
	const result = presetSchema.safeParse(fieldsOf(formData));
	if (!result.success) {
		return { error: firstIssue(result.error) };
	}
	return {
		parsed: {
			...result.data,
			...loginWallFromForm(formData),
			env: envFrom(result.data.env),
		},
	};
}

const autoStopSchema = z.discriminatedUnion("autoStopMode", [
	z.object({ autoStopMode: z.literal("off") }),
	z.object({
		autoStopMinutes: z.coerce
			.number("Give the auto-stop delay in minutes.")
			.int("The auto-stop delay must be whole minutes.")
			.min(5, "The auto-stop delay must be at least 5 minutes.")
			.max(10_080, "The auto-stop delay can't exceed a week."),
		autoStopMode: z.enum(AUTO_STOP_MODES),
	}),
]);

/**
 * Validates the Overview's auto-stop form: off, or a mode with its delay.
 *
 * @returns The mode (null for off) and its minutes, or the first validation
 *   error message.
 */
export function parseAutoStop(
	formData: FormData,
):
	| { error: string }
	| { parsed: { minutes: number | null; mode: AutoStopMode | null } } {
	const result = autoStopSchema.safeParse(Object.fromEntries(formData));
	if (!result.success) {
		return { error: firstIssue(result.error) };
	}
	return result.data.autoStopMode === "off"
		? { parsed: { minutes: null, mode: null } }
		: {
				parsed: {
					minutes: result.data.autoStopMinutes,
					mode: result.data.autoStopMode,
				},
			};
}

/** A fresh random IDE password, 24 URL-safe characters. */
export function generateWorkstationPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return Buffer.from(bytes).toString("base64url");
}
