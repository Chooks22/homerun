import type { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";

/**
 * Applies the Homerun Manifest a git service keeps in its repository, read at
 * the ref this deploy builds, before the rest of the deploy reads the
 * service's settings. Logs what it applied and what the service's scope left
 * out. A manifest that's invalid or refused fails the deploy. The manifest
 * service is imported on first use: it applies through the settings service,
 * which imports the deploy service back.
 *
 * @returns The commit the manifest was read at, for the build to check out
 *   the same one, or null when the service isn't built from git or its
 *   repository has no manifest.
 */
export async function applyRepoManifest(ctx: {
	dep: DeploymentDTO;
	svc: ServiceDTO;
	userId: string;
}): Promise<string | null> {
	const { dep, svc, userId } = ctx;
	const row = svc.toJSON();
	if (row.buildSource !== "git" || !row.gitUrl) {
		return null;
	}
	const { ManifestService, manifestScopeFor } = await import(
		"../manifest.service.ts"
	);
	const found = await ManifestService.readFromRepo(
		svc,
		row.gitRef ?? "main",
		userId,
	);
	if (!found) {
		return null;
	}
	const { applied, ignored } = await ManifestService.apply(
		svc,
		found.manifest,
		manifestScopeFor(row),
		{ deploying: true, userId },
	);
	await dep.appendLog(
		`Applied ${found.path}${found.commit ? ` from ${found.commit.slice(0, 7)}` : ""}: ${applied.length > 0 ? applied.join(", ") : "nothing to change"}`,
	);
	if (ignored.length > 0) {
		await dep.appendLog(
			`Left out of ${found.path} for this service: ${ignored.join(", ")}`,
		);
	}
	return found.commit;
}
