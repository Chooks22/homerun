import { z } from "zod";
import { parseDotEnv } from "#lib/env-parse.js";
import {
	DEFAULT_WORKSTATION_HOME,
	DEFAULT_WORKSTATION_IMAGE,
	DEFAULT_WORKSTATION_PORT,
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

const workstationSettingsSchema = z.object({
	cpuLimit: optionalNumber(
		z.number().positive("CPU limit must be above 0.").max(256),
	),
	env: z.string().nullish(),
	gitBranch: optionalText.refine((value) => !value?.startsWith("-"), {
		message: "A branch name can't start with a dash.",
	}),
	gitUrl: optionalText.refine(
		(value) => !value || /^https?:\/\/[^/\s]+\/\S+$/.test(value),
		{ message: "The repository must be an http(s) clone URL." },
	),
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

const newWorkstationSchema = workstationSettingsSchema.extend({
	name: z.string().trim().min(1, "Give the workstation a name.").max(80),
	remoteHostId: optionalText,
});

/** A workstation's editable settings, normalised into DTO-ready columns. */
export interface WorkstationSettings {
	cpuLimit: number | null;
	env: Record<string, string>;
	gitBranch: string | null;
	gitUrl: string | null;
	homePath: string;
	image: string;
	memoryLimitMb: number | null;
	port: number;
}

/** The settings plus what only the create form picks. */
export interface NewWorkstationForm extends WorkstationSettings {
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

/**
 * Validates the Settings tab's fields.
 *
 * @returns The parsed settings, or the first validation error message.
 */
export function parseWorkstationSettings(
	formData: FormData,
): { error: string } | { parsed: WorkstationSettings } {
	const result = workstationSettingsSchema.safeParse(
		Object.fromEntries(formData),
	);
	if (!result.success) {
		return { error: firstIssue(result.error) };
	}
	return { parsed: { ...result.data, env: envFrom(result.data.env) } };
}

/**
 * Validates the new-workstation form.
 *
 * @returns The parsed fields, or the first validation error message.
 */
export function parseNewWorkstation(
	formData: FormData,
): { error: string } | { parsed: NewWorkstationForm } {
	const result = newWorkstationSchema.safeParse(Object.fromEntries(formData));
	if (!result.success) {
		return { error: firstIssue(result.error) };
	}
	return { parsed: { ...result.data, env: envFrom(result.data.env) } };
}

/** A fresh random IDE password, 24 URL-safe characters. */
export function generateWorkstationPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	return Buffer.from(bytes).toString("base64url");
}
