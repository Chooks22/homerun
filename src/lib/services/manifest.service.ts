import type { ServiceDTO } from "#lib/dto/service-dto.js";
import { Logger } from "#lib/logger.js";
import {
	type ManifestInput,
	type ManifestScope,
	manifestFields,
	manifestPaths,
	parseManifest,
} from "#lib/server/manifest.js";
import { WorkerClient } from "#lib/server/worker-client.js";
import { resolveGitCredential } from "./deploy/helpers.ts";
import {
	ServiceSettingsService,
	type SettingsActor,
} from "./service-settings.service.ts";

const logger = new Logger("Manifest");

/** A manifest that can't be applied: unreadable, invalid, or refused by the service's settings checks. */
export class ManifestError extends Error {
	constructor(
		message: string,
		readonly status = 400,
		readonly body: Record<string, unknown> = { error: message },
	) {
		super(message);
	}
}

export interface RepoManifest {
	commit: string | null;
	manifest: ManifestInput;
	path: string;
}

export interface AppliedManifest {
	applied: string[];
	ignored: string[];
}

interface RepoFileResponse {
	commit: string;
	content: string;
	path: string;
}

/** The scope a service takes a manifest at: a preview or a canary only takes how it's built and run, never its access, routing or preview policy. */
export function manifestScopeFor(row: {
	channelCanary: boolean;
	previewParentId: string | null;
}): ManifestScope {
	return row.previewParentId !== null || row.channelCanary
		? "build-runtime"
		: "full";
}

/**
 * Homerun Manifests: a service's configuration as a file, read from its
 * repository on every deploy or applied directly through the API and CLI,
 * always through `ServiceSettingsService.apply` so it gets the same checks as
 * the dashboard.
 */
class ManifestServiceClass {
	/**
	 * Applies the part of `manifest` that `scope` allows to `svc`. Its
	 * envVars are merged into the service's environment, so a variable set
	 * on the dashboard (a secret, say) survives a manifest that doesn't name
	 * it. Never grants host access, whoever applies it.
	 *
	 * @throws {ManifestError} When the settings checks refuse a value;
	 *   nothing is saved then.
	 */
	async apply(
		svc: ServiceDTO,
		manifest: ManifestInput,
		scope: ManifestScope,
		actor: Omit<SettingsActor, "hostAccess">,
	): Promise<AppliedManifest> {
		const { fields, ignored } = manifestFields(
			manifest,
			scope,
			svc.buildSource === "git",
		);
		const input = fields.envVars
			? { ...fields, envVars: { ...svc.toJSON().envVars, ...fields.envVars } }
			: fields;
		const refusal = await ServiceSettingsService.save(svc, input, {
			...actor,
			hostAccess: false,
		});
		if (refusal instanceof Error) {
			throw new ManifestError(refusal.message, refusal.status, refusal.body());
		}
		logger.info(
			`Manifest applied: service=${svc.id} fields=${Object.keys(fields).join(",")} user=${actor.userId}`,
		);
		return { applied: Object.keys(fields), ignored };
	}

	/**
	 * Reads the service's manifest from its repository at `ref`, nearest to
	 * the build context first, through the worker (a shallow clone without
	 * file contents, with the same credential the build uses).
	 *
	 * @returns The manifest, its path and the commit it was read at, or null
	 *   when the repository has none.
	 * @throws {ManifestError} When the repository can't be read or the file
	 *   isn't a valid manifest.
	 */
	async readFromRepo(
		svc: ServiceDTO,
		ref: string,
		userId: string,
	): Promise<RepoManifest | null> {
		const row = svc.toJSON();
		if (!row.gitUrl) {
			return null;
		}
		const file = await WorkerClient.post<RepoFileResponse>("/v1/git/file", {
			credential: await resolveGitCredential(row.gitUrl, userId),
			paths: manifestPaths(row.gitBuildContext),
			ref,
			url: row.gitUrl,
		}).catch((error: unknown) => {
			throw new ManifestError(
				`Couldn't look for a manifest in the repository: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		if (!file.path) {
			return null;
		}
		const parsed = parseManifest(file.content, file.path);
		if ("errors" in parsed) {
			throw new ManifestError(
				`${file.path} isn't a valid Homerun Manifest: ${parsed.errors.join("; ")}`,
			);
		}
		return {
			commit: file.commit || null,
			manifest: parsed.manifest,
			path: file.path,
		};
	}
}

export const ManifestService = new ManifestServiceClass();
