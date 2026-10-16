import type { BaseDockerService, Constructor } from "./base.ts";
import type { RegistryAuth } from "./containers.ts";
import { MANAGED_LABEL } from "./labels.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const NS_PER_MS = 1_000_000;

export interface OneOffRunParams {
	auth?: RegistryAuth;
	binds?: string[];
	cmd?: string[];
	entrypoint?: string[] | null;
	envVars?: Record<string, string>;
	image: string;
	/** Other images mounted read-only at `target`, to run a binary they ship (Docker Engine 28 or newer). */
	imageMounts?: { image: string; target: string }[];
	labels?: Record<string, string>;
	networkName?: string | null;
	/** `"host"` shares the host's PID namespace, which is what lets a privileged helper `nsenter` into PID 1. */
	pidMode?: string | null;
	privileged?: boolean;
	tag: string;
	timeoutMs?: number;
	workingDir?: string | null;
}

export interface ExtractIntoVolumeParams {
	archive: Buffer;
	image: string;
	mountPath: string;
	tag: string;
	volumeName: string;
}

export interface OneOffRunResult {
	exitCode: number;
	stderr: Buffer;
	stdout: Buffer;
	timedOut: boolean;
}

interface WorkerOneOffResult {
	ExitCode: number;
	Stderr: string | null;
	Stdout: string | null;
	TimedOut: boolean;
}

/** Turns the worker's base64-encoded output bytes back into a Buffer, empty when the container said nothing. */
function decodeOutput(value: string | null): Buffer {
	return value ? Buffer.from(value, "base64") : Buffer.alloc(0);
}

/** Mixin adding one-off/helper container support : running a throwaway container to completion, and extracting an archive into a named volume. */
// oxlint-disable-next-line max-lines-per-function -- mixin factory: the body is a class definition, not a procedure
export function DockerOneOffMixin<TBase extends Constructor<BaseDockerService>>(
	Base: TBase,
) {
	return class DockerOneOffService extends Base {
		/**
		 * Unpacks a tar into a named volume (or host directory): the worker
		 * runs a throwaway helper from `image:tag` with the volume mounted and
		 * pipes the archive into its `tar -x`, pulling the image first if the
		 * daemon lacks it. Nothing is needed on this host beyond the archive.
		 *
		 * @throws When the helper can't run or its `tar` rejects the archive.
		 */
		async extractIntoVolume(params: ExtractIntoVolumeParams): Promise<void> {
			await this.worker.putRaw(
				"/v1/volumes/archive",
				new Uint8Array(params.archive),
				{
					image: `${params.image}:${params.tag}`,
					source: params.volumeName,
					target: params.mountPath,
				},
			);
		}

		/**
		 * Runs a container to completion and collects its stdout/stderr and
		 * exit code, pulling the image first if the daemon lacks it. Kills the
		 * container if it hasn't finished within `timeoutMs`, 30 minutes by
		 * default (`timedOut: true` in the result rather than throwing). The
		 * worker owns the whole run and always removes the container, whatever
		 * the outcome.
		 */
		async runOneOff(params: OneOffRunParams): Promise<OneOffRunResult> {
			const result = await this.worker.post<WorkerOneOffResult>("/v1/one-off", {
				Auth: params.auth,
				Binds: params.binds,
				Cmd: params.cmd,
				Entrypoint: params.entrypoint ?? undefined,
				Env: Object.entries(params.envVars ?? {}).map(
					([key, value]) => `${key}=${value}`,
				),
				Image: `${params.image}:${params.tag}`,
				ImageMounts: params.imageMounts,
				Labels: { ...params.labels, [MANAGED_LABEL]: "true" },
				NetworkMode: params.networkName ?? undefined,
				PidMode: params.pidMode ?? undefined,
				Privileged: params.privileged ?? false,
				Timeout: (params.timeoutMs ?? DEFAULT_TIMEOUT_MS) * NS_PER_MS,
				WorkingDir: params.workingDir ?? undefined,
			});
			return {
				exitCode: result.ExitCode,
				stderr: decodeOutput(result.Stderr),
				stdout: decodeOutput(result.Stdout),
				timedOut: result.TimedOut,
			};
		}
	};
}
