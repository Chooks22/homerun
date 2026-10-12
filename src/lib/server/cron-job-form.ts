import {
	type CronJobFile,
	type CronJobKind,
	invalidFilePath,
	MAX_CRON_JOB_FILE_BYTES,
	MAX_CRON_JOB_FILES,
	type ScriptRuntime,
} from "#lib/cron-job-script.js";
import {
	type CronJobInput,
	cronJobSchema,
	DEFAULT_CRON_JOB_TIMEOUT_SECONDS,
} from "#lib/server/validation/cron-job.js";
import { parseEnvVars } from "#lib/server/validation/service.js";
import { parseCronSchedule } from "#lib/services/cron/cron-expression.js";
import { encryptSecret } from "#lib/services/secrets.js";

export interface ParsedCronJobForm {
	command: string | null;
	description: string | null;
	enabled: boolean;
	envVars: Record<string, string>;
	files: CronJobFile[];
	image: string | null;
	kind: CronJobKind;
	name: string;
	registryPasswordEnc: string | null;
	registryUrl: string | null;
	registryUsername: string | null;
	remoteHostId: string | null;
	runtime: ScriptRuntime | null;
	schedule: string;
	source: string | null;
	tag: string;
	timeoutSeconds: number;
}

export type CronJobFormResult =
	| { error: string }
	| { parsed: ParsedCronJobForm };

function validate(
	input: CronJobInput,
	options: { hostAccess: boolean },
): string | null {
	if (input.kind === "exec" && !options.hostAccess) {
		return "A host command job needs write access to System.";
	}
	if (!parseCronSchedule(input.schedule)) {
		return 'Invalid schedule : use standard 5-field cron syntax (e.g. "0 3 * * *").';
	}
	return null;
}

function invalidFiles(files: CronJobFile[]): string | null {
	if (files.length > MAX_CRON_JOB_FILES) {
		return `At most ${MAX_CRON_JOB_FILES} config files.`;
	}
	const seen = new Set<string>();
	for (const file of files) {
		const invalid = invalidFilePath(file.path);
		if (invalid) {
			return invalid;
		}
		if (seen.has(file.path)) {
			return `"${file.path}" is listed twice.`;
		}
		seen.add(file.path);
		if (
			new TextEncoder().encode(file.content).length > MAX_CRON_JOB_FILE_BYTES
		) {
			return `"${file.path}" is over ${MAX_CRON_JOB_FILE_BYTES / 1000} kB.`;
		}
		if (file.content.includes("\0")) {
			return `"${file.path}" contains a NUL byte : config files are text only.`;
		}
	}
	return null;
}

/** The config files a job of `kind` keeps : none for a host command, blank paths dropped. */
function filesFor(kind: CronJobKind, files: CronJobFile[]): CronJobFile[] {
	if (kind === "exec") {
		return [];
	}
	return files
		.map((file) => ({ content: file.content, path: file.path.trim() }))
		.filter((file) => file.path !== "");
}

/** The columns that only apply to some kinds, nulled for the others. */
function kindColumns(
	input: CronJobInput,
): Pick<
	ParsedCronJobForm,
	"command" | "image" | "remoteHostId" | "runtime" | "source"
> {
	const script = input.kind === "script";
	return {
		command: script ? null : input.command?.trim() || null,
		image: input.kind === "image" ? (input.image?.trim() ?? null) : null,
		remoteHostId:
			input.kind === "exec" ? null : input.remoteHostId?.trim() || null,
		runtime: script ? (input.runtime ?? null) : null,
		source: script ? (input.source ?? null) : null,
	};
}

/**
 * Validates a cron job's fields and normalises them into DTO-ready columns :
 * trims text, drops fields that don't apply to the job's kind, encrypts the
 * registry password and defaults the tag and timeout. `raw` is the form's
 * fields or a JSON body, `envVars` its variables, `files` the config files
 * written into its container (dropped for a host command).
 *
 * @param options.hostAccess Whether the caller may create host command (exec) jobs, which needs write access to System.
 * @returns The parsed fields, or the first validation error message.
 */
export function parseCronJobInput(
	raw: Record<string, unknown>,
	envVars: Record<string, string>,
	files: CronJobFile[],
	options: { hostAccess: boolean },
): CronJobFormResult {
	const result = cronJobSchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		return { error: first?.message ?? "Check the form for errors." };
	}
	const input = result.data;

	const keptFiles = filesFor(input.kind, files);
	const invalid = validate(input, options) ?? invalidFiles(keptFiles);
	if (invalid) {
		return { error: invalid };
	}

	const registryPassword = input.registryPassword?.trim() || null;

	return {
		parsed: {
			...kindColumns(input),
			description: input.description?.trim() || null,
			enabled: input.enabled,
			envVars,
			files: keptFiles,
			kind: input.kind,
			name: input.name.trim(),
			registryPasswordEnc: registryPassword
				? encryptSecret(registryPassword)
				: null,
			registryUrl: input.registryUrl?.trim() || null,
			registryUsername: input.registryUsername?.trim() || null,
			schedule: input.schedule.trim(),
			tag: input.tag?.trim() || "latest",
			timeoutSeconds: input.timeoutSeconds ?? DEFAULT_CRON_JOB_TIMEOUT_SECONDS,
		},
	};
}

/** Validates a submitted cron job form, see `parseCronJobInput`. */
export function parseCronJobForm(
	formData: FormData,
	options: { hostAccess: boolean },
): CronJobFormResult {
	return parseCronJobInput(
		Object.fromEntries(formData),
		parseEnvVars(formData),
		parseFiles(formData),
		options,
	);
}

/** The form's config file rows, paired by position, blank paths included. */
function parseFiles(formData: FormData): CronJobFile[] {
	const contents = formData.getAll("fileContent").map(String);
	return formData
		.getAll("filePath")
		.map(String)
		.map((path, i) => ({
			content: (contents[i] ?? "").replace(/\r\n/g, "\n"),
			path,
		}));
}
