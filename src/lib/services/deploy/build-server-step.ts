import {
	type BuildSlot,
	buildServerCandidates,
	pickBuildServer,
} from "#lib/build-servers.js";
import { reserveBuildHost } from "#lib/dto/build-slot-dto.js";
import type { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import type { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import type { JobDTO } from "#lib/dto/job-dto.js";
import { RemoteHostDTO } from "#lib/dto/remote-host-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import { settings } from "#lib/settings.js";
import { JobDeferredError } from "../queue/deferred.ts";

/** Thrown when a deploy waited `settings.docker.buildSlotTimeoutMs` for a build slot without getting one. */
export class BuildSlotTimeoutError extends Error {
	override name = "BuildSlotTimeoutError";
}

interface BuildServerContext {
	dep: DeploymentDTO;
	instance: InstanceSettingsDTO;
	job: JobDTO;
	svc: ServiceDTO;
}

/** The message a deploy logs while its build servers are full. */
function fullMessage(candidates: string[], names: Map<string, string>): string {
	if (candidates.length > 1) {
		return "Every build server is running as many builds as it's allowed, waiting for a free slot.";
	}
	const name = names.get(candidates[0] ?? "") ?? "The build server";
	return `${name} is running as many builds as it's allowed, waiting for a free slot.`;
}

/**
 * Picks the build server a git build runs on and holds one of its build
 * slots for the deploy job until the job stops running: the pinned server,
 * or the least busy registered one when the service takes any free server
 * or the instance doesn't build on this host. Runs before the deploy's
 * prepare step changes anything, so a full server puts the job back in the
 * queue to try again in `settings.docker.buildSlotPollMs`, logging once that
 * it's waiting.
 *
 * @returns The reserved host id, or null to build on this host.
 * @throws {JobDeferredError} When every candidate is at its concurrent-build
 *   limit (its own, else the instance's).
 * @throws {BuildSlotTimeoutError} When the job has been waiting longer than
 *   `settings.docker.buildSlotTimeoutMs`.
 */
export async function reserveBuildServer(
	ctx: BuildServerContext,
): Promise<string | null> {
	const { dep, instance, job, svc } = ctx;
	const servers = await RemoteHostDTO.listBuildServers();
	const candidates = buildServerCandidates({
		buildOnHost: instance.buildOnHost,
		choice: {
			buildServerAny: svc.toJSON().buildServerAny,
			buildServerRemoteHostId: svc.buildServerRemoteHostId,
		},
		serverIds: servers.map((s) => s.id),
	});
	if (candidates.length === 0) {
		return null;
	}
	const limits = new Map(
		servers.map((s) => [
			s.id,
			s.maxConcurrentBuilds ?? instance.buildConcurrency,
		]),
	);
	const names = new Map(servers.map((s) => [s.id, s.name]));
	const slots = (active: Map<string, number>) =>
		candidates.map(
			(id): BuildSlot => ({
				active: active.get(id) ?? 0,
				id,
				limit: limits.get(id) ?? instance.buildConcurrency,
			}),
		);
	const hostId = await reserveBuildHost(job.id, (active) =>
		pickBuildServer(slots(active)),
	);
	if (hostId) {
		await dep.appendLog(
			`Building on ${names.get(hostId) ?? "a build server"}.`,
		);
		return hostId;
	}

	const { buildSlotPollMs, buildSlotTimeoutMs } = settings.docker;
	const waitingSince =
		job.deferral?.gate === "build-slot" ? job.deferral.since : null;
	if (
		waitingSince &&
		Date.now() - waitingSince.getTime() >= buildSlotTimeoutMs
	) {
		throw new BuildSlotTimeoutError(
			`No build slot freed up within ${buildSlotTimeoutMs / 60_000} minutes. The build will not carry on.`,
		);
	}
	const message = fullMessage(candidates, names);
	if (!waitingSince) {
		await dep.appendLog(message);
	}
	throw new JobDeferredError(
		message,
		"build-slot",
		new Date(Date.now() + buildSlotPollMs),
	);
}
