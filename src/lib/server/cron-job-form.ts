import {
	type CronJobFile,
	type CronJobKind,
	type CronJobMount,
	cronJobNeedsHostAccess,
	invalidFileMode,
	invalidFilePath,
	MAX_CRON_JOB_FILE_BYTES,
	MAX_CRON_JOB_FILES,
	type ScriptRuntime,
} from "#lib/cron-job-script.js";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import { can, type Permissions } from "#lib/permissions.js";
import type { CronJob } from "#lib/server/db/schema.js";
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
	dockerSocket: boolean;
	enabled: boolean;
	envVars: Record<string, string>;
	files: CronJobFile[];
	image: string | null;
	kind: CronJobKind;
	mounts: CronJobMount[];
	name: string;
	registryPasswordEnc: string | null;
	registryUrl: string | null;
	registryUsername: string | null;
	remoteHostId: string | null;
	runAsUser: string | null;
	runtime: ScriptRuntime | null;
	schedule: string;
	source: string | null;
	tag: string;
	timeoutSeconds: number;
}

export interface CronJobLists {
	envVars: Record<string, string>;
	files: CronJobFile[];
	mounts: CronJobMount[];
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
	if (input.dockerSocket && input.kind !== "exec" && !options.hostAccess) {
		return "Giving a job the Docker socket needs write access to System.";
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
		const badMode = file.mode ? invalidFileMode(file.mode) : null;
		if (badMode) {
			return badMode;
		}
	}
	return null;
}

function invalidMounts(mounts: CronJobMount[]): string | null {
	const seen = new Set<string>();
	for (const mount of mounts) {
		if (!mount.volumeId) {
			return `Pick a volume for "${mount.containerPath}".`;
		}
		const invalid = invalidFilePath(mount.containerPath);
		if (invalid) {
			return invalid;
		}
		if (seen.has(mount.containerPath)) {
			return `"${mount.containerPath}" is mounted twice.`;
		}
		seen.add(mount.containerPath);
	}
	return null;
}

/** The volumes a job of `kind` keeps : none for a host command, rows with neither a volume nor a path dropped. */
function mountsFor(kind: CronJobKind, mounts: CronJobMount[]): CronJobMount[] {
	if (kind === "exec") {
		return [];
	}
	return mounts
		.map((mount) => ({
			containerPath: mount.containerPath.trim(),
			readOnly: mount.readOnly,
			volumeId: mount.volumeId.trim(),
		}))
		.filter((mount) => mount.containerPath !== "" || mount.volumeId !== "");
}

/** The config files a job of `kind` keeps : none for a host command, blank paths dropped. */
function filesFor(kind: CronJobKind, files: CronJobFile[]): CronJobFile[] {
	if (kind === "exec") {
		return [];
	}
	return files
		.map((file) => {
			const mode = file.mode?.trim();
			return {
				content: file.content,
				path: file.path.trim(),
				...(mode ? { mode } : {}),
			};
		})
		.filter((file) => file.path !== "");
}

/** The columns that only apply to some kinds, nulled for the others. */
function kindColumns(
	input: CronJobInput,
): Pick<
	ParsedCronJobForm,
	| "command"
	| "dockerSocket"
	| "image"
	| "remoteHostId"
	| "runAsUser"
	| "runtime"
	| "source"
> {
	const script = input.kind === "script";
	const exec = input.kind === "exec";
	return {
		command: script ? null : input.command?.trim() || null,
		dockerSocket: !exec && input.dockerSocket,
		image: input.kind === "image" ? (input.image?.trim() ?? null) : null,
		remoteHostId: exec ? null : input.remoteHostId?.trim() || null,
		runAsUser: exec ? null : input.runAsUser || null,
		runtime: script ? (input.runtime ?? null) : null,
		source: script ? (input.source ?? null) : null,
	};
}

/**
 * Validates a cron job's fields and normalises them into DTO-ready columns :
 * trims text, drops fields that don't apply to the job's kind, encrypts the
 * registry password and defaults the tag and timeout. `raw` is the form's
 * fields or a JSON body; `lists` carries its env vars, the config files
 * written into its container and the storage volumes mounted into it (both
 * dropped for a host command).
 *
 * @param options.hostAccess Whether the caller may create host command (exec) jobs or give a job the Docker socket, both needing write access to System.
 * @returns The parsed fields, or the first validation error message.
 */
export function parseCronJobInput(
	raw: Record<string, unknown>,
	lists: CronJobLists,
	options: { hostAccess: boolean },
): CronJobFormResult {
	const { envVars, files, mounts } = lists;
	const result = cronJobSchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		return { error: first?.message ?? "Check the form for errors." };
	}
	const input = result.data;

	const keptFiles = filesFor(input.kind, files);
	const keptMounts = mountsFor(input.kind, mounts);
	const invalid =
		validate(input, options) ??
		invalidFiles(keptFiles) ??
		invalidMounts(keptMounts);
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
			mounts: keptMounts,
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
		listsFrom(formData),
		options,
	);
}

/** The env vars, config files and volume rows a form submitted. */
function listsFrom(formData: FormData): CronJobLists {
	return {
		envVars: parseEnvVars(formData),
		files: parseFiles(formData),
		mounts: parseMounts(formData),
	};
}

/** The form's volume rows, paired by position, blank rows included. */
function parseMounts(formData: FormData): CronJobMount[] {
	const paths = formData.getAll("mountPath").map(String);
	const readOnly = formData.getAll("mountReadOnly").map(String);
	return formData
		.getAll("mountVolumeId")
		.map(String)
		.map((volumeId, i) => ({
			containerPath: paths[i] ?? "",
			readOnly: readOnly[i] === "1",
			volumeId,
		}));
}

/** The form's config file rows, paired by position, blank paths included. */
function parseFiles(formData: FormData): CronJobFile[] {
	const contents = formData.getAll("fileContent").map(String);
	const modes = formData.getAll("fileMode").map(String);
	return formData
		.getAll("filePath")
		.map(String)
		.map((path, i) => ({
			content: (contents[i] ?? "").replace(/\r\n/g, "\n"),
			mode: modes[i] ?? "",
			path,
		}));
}

export type CronJobSection = "configuration" | "settings";

const SECTION_FIELDS: Record<CronJobSection, string[]> = {
	configuration: [
		"command",
		"dockerSocket",
		"image",
		"kind",
		"registryUrl",
		"registryUsername",
		"remoteHostId",
		"runAsUser",
		"runtime",
		"source",
		"tag",
	],
	settings: ["description", "enabled", "name", "schedule", "timeoutSeconds"],
};

/**
 * Validates one tab of a stored cron job's form : the fields `section` owns
 * come from `formData` (a missing checkbox is off, a blank field clears), the
 * rest from `job` as stored, and the whole job then goes through
 * `parseCronJobInput`. The configuration tab also carries the env vars,
 * config files and volumes.
 */
export function parseCronJobSection(
	job: CronJob,
	formData: FormData,
	section: CronJobSection,
	options: { hostAccess: boolean },
): CronJobFormResult {
	const owned = SECTION_FIELDS[section];
	const {
		envVars,
		files,
		mounts,
		registryPasswordEnc: _password,
		...row
	} = job;
	const kept = Object.fromEntries(
		Object.entries(row).filter(
			([key, value]) => value !== null && !owned.includes(key),
		),
	);
	const raw = { ...kept, ...Object.fromEntries(formData) };
	return parseCronJobInput(
		raw,
		section === "configuration"
			? listsFrom(formData)
			: { envVars: envVars ?? {}, files, mounts },
		options,
	);
}

/**
 * The cron job `id` if the caller may manage it, or why not : missing, or a
 * host command or Docker socket job without write access to System.
 */
export async function manageableCronJob(
	id: string | null,
	permissions: Permissions,
): Promise<{ job: CronJobDTO } | { error: string; status: 403 | 404 }> {
	const job = id ? await CronJobDTO.get(id) : null;
	if (!job) {
		return { error: "Cron job not found.", status: 404 };
	}
	if (cronJobNeedsHostAccess(job) && !can(permissions, "system", "write")) {
		return {
			error:
				"A host command or Docker socket job needs write access to System.",
			status: 403,
		};
	}
	return { job };
}
