import { stripAnsi } from "#lib/ansi.js";
import { config } from "#lib/config.js";
import { DeploymentDTO } from "#lib/dto/deployment-dto.js";
import { NotificationDTO } from "#lib/dto/notification-dto.js";
import type { ServiceDTO } from "#lib/dto/service-dto.js";
import {
	type ImageUpdateAvailable,
	type ImageUpdateState,
	type ImageUpdateTrial,
	isValidTag,
	newerVersionTag,
	type PinCandidates,
	parseVersionTag,
	type RegistryTag,
	suggestLocalTag,
	tagsMatchingDigest,
	updateKey,
} from "#lib/image-versions.js";
import { Logger } from "#lib/logger.js";
import { isNotFound } from "#lib/server/worker-client.js";
import { ApiService } from "./api.service.ts";
import { DeploymentService } from "./deploy.service.ts";
import {
	dockerHealthcheck,
	healthcheckTimingOf,
} from "./docker/healthcheck.ts";
import { listeningHealthcheck } from "./docker/readiness.ts";
import { DockerService } from "./docker.service.ts";
import { NotificationChannelService } from "./notification-channel.service.ts";
import { updateAvailableMessage } from "./notification-messages.ts";

const logger = new Logger("Updates");

const VERSION_LABELS = [
	"org.opencontainers.image.version",
	"org.label-schema.version",
];
const TRIAL_LABEL = "homerun.update-trial";
const TRIAL_SETTLE_MS = 20_000;
const TRIAL_HEALTH_TIMEOUT_MS = 180_000;
const TRIAL_POLL_MS = 2000;
const TRIAL_LOG_LINES = 20;
const MAX_TRIAL_MESSAGE = 4000;

/** A service's version pinning and update-check state, flat, as the REST API, the CLI and the Terraform data source read it. */
export interface ServiceVersionState {
	availableDigest: string | null;
	availableFoundAt: string | null;
	availableTag: string | null;
	checkedAt: string | null;
	checkError: string | null;
	id: string;
	image: string;
	pinned: boolean;
	pinnedFromTag: string | null;
	pinnedLocally: boolean;
	tag: string;
	trialAt: string | null;
	trialMessage: string | null;
	trialStatus: ImageUpdateTrial["status"] | null;
	trialTag: string | null;
	updateCheckEnabled: boolean;
	updateTrialEnabled: boolean;
}

interface RunningImage {
	digest: string | null;
	imageId: string | null;
}

interface TrialInspect {
	State?: {
		ExitCode?: number;
		Health?: { Status?: string };
		Restarting?: boolean;
		Running?: boolean;
		Status?: string;
	};
}

/** The available update's fields of a `ServiceVersionState`. */
function availableState(available: ImageUpdateAvailable | null) {
	return {
		availableDigest: available?.digest ?? null,
		availableFoundAt: available?.foundAt ?? null,
		availableTag: available?.tag ?? null,
	};
}

/** The trial run's fields of a `ServiceVersionState`. */
function trialState(trial: ImageUpdateTrial | null) {
	return {
		trialAt: trial?.at ?? null,
		trialMessage: trial?.message ?? null,
		trialStatus: trial?.status ?? null,
		trialTag: trial?.tag ?? null,
	};
}

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The error message of whatever was thrown. */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Version pinning and update checks for image-sourced services: finding the
 * registry tag the running image was published under, pinning to it (or to a
 * tag made on this host when none matches), watching the registry for a newer
 * release, trying that release in a throwaway container off every network and
 * volume, and telling the user about it.
 */
class ImageVersionServiceClass {
	readonly #inFlight = new Set<string>();

	/** Why the service has no version pinning or update checks (built from git, or an environment, preview or canary of another service), or null when it has them. */
	unsupportedReason(svc: ServiceDTO): string | null {
		if (svc.buildSource !== "image") {
			return "Only a service deployed from an image has version pinning and update checks.";
		}
		if (svc.toJSON().previewParentId) {
			return "Version pinning and update checks are set on the service itself, not on its environments, previews or canary.";
		}
		return null;
	}

	/** The service's pin and its last update check, flat. */
	describe(svc: ServiceDTO): ServiceVersionState {
		const row = svc.toJSON();
		const check = row.updateCheck;
		return {
			...availableState(check?.available ?? null),
			...trialState(check?.trial ?? null),
			checkedAt: check?.checkedAt ?? null,
			checkError: check?.error ?? null,
			id: svc.id,
			image: svc.image,
			pinned: row.pinnedFromTag !== null,
			pinnedFromTag: row.pinnedFromTag,
			pinnedLocally: row.pinnedLocally,
			tag: svc.tag,
			updateCheckEnabled: row.updateCheckEnabled,
			updateTrialEnabled: row.updateTrialEnabled,
		};
	}

	/**
	 * Turns watching the registry for updates, and trying each one first, on
	 * or off; a setting left out keeps its value. Turning the watch off
	 * forgets the last check, turning it on runs the first check in the
	 * background.
	 */
	async setWatch(
		svc: ServiceDTO,
		input: { updateCheckEnabled?: boolean; updateTrialEnabled?: boolean },
	): Promise<void> {
		const updateCheckEnabled =
			input.updateCheckEnabled ?? svc.toJSON().updateCheckEnabled;
		await svc.update({
			updateCheckEnabled,
			updateTrialEnabled:
				input.updateTrialEnabled ?? svc.toJSON().updateTrialEnabled,
			...(updateCheckEnabled ? {} : { updateCheck: null }),
		});
		if (updateCheckEnabled && !svc.toJSON().updateCheck) {
			await this.check(svc, { background: true });
		}
	}

	/** The digest and local image id the service's live revision runs, from its newest running deployment, falling back to the local image behind its tag. */
	async #runningImage(svc: ServiceDTO): Promise<RunningImage> {
		const revisions = await DeploymentDTO.listForService(svc.id, 20);
		const live = revisions
			.map((dep) => dep.toJSON())
			.find(
				(row) => row.status === "running" && (row.imageDigest || row.imageId),
			);
		if (live) {
			return { digest: live.imageDigest, imageId: live.imageId };
		}
		const local = await DockerService.worker
			.get<{ digest?: string | null; id: string | null }>("v1/images/id", {
				ref: `${svc.image}:${svc.tag}`,
			})
			.catch(() => ({ digest: null, id: null }));
		return { digest: local.digest || null, imageId: local.id };
	}

	/** A local image's version label (OCI, else label-schema), or null. */
	async #versionLabel(ref: string): Promise<string | null> {
		const inspected = await DockerService.worker
			.get<{ Config?: { Labels?: Record<string, string> | null } }>(
				"v1/images/inspect",
				{ ref },
			)
			.catch(() => null);
		const labels = inspected?.Config?.Labels ?? {};
		return (
			VERSION_LABELS.map((key) => labels[key]).find((value) => value) ?? null
		);
	}

	/** Lists the service image's registry tags, looking up digests for its version-shaped tags newest first when the registry doesn't hand them out. */
	#listTags(svc: ServiceDTO): Promise<RegistryTag[]> {
		return ApiService.listTags(svc.image, {
			auth: DockerService.buildAuthConfig(svc.toJSON()),
			digestFor: (names) =>
				names
					.map((name) => parseVersionTag(name))
					.filter((parsed) => parsed !== null)
					.sort((a, b) =>
						b.numbers.join(".").localeCompare(a.numbers.join("."), undefined, {
							numeric: true,
						}),
					)
					.map((parsed) => parsed.tag),
			registryUrl: svc.registryUrl,
		});
	}

	/**
	 * The registry tags published for exactly the image the service runs, and
	 * a tag to offer for pinning on this host when none is. The suggestion is
	 * the image's version label when it carries one.
	 * A registry that can't be listed reads as no match, so the local tag is
	 * still offered.
	 * @throws when the service isn't deployed from an image.
	 */
	async findPinCandidates(svc: ServiceDTO): Promise<PinCandidates> {
		if (svc.buildSource !== "image") {
			throw new Error("Only a service deployed from an image can be pinned.");
		}
		const running = await this.#runningImage(svc);
		const label = await this.#versionLabel(
			running.imageId ?? `${svc.image}:${svc.tag}`,
		);
		const suggestion = suggestLocalTag(svc.tag, label);
		if (!running.digest) {
			return { digest: null, matches: [], suggestion };
		}
		const tags = await this.#listTags(svc).catch((err: unknown) => {
			logger.warn(`Tag listing failed: service=${svc.id} : ${messageOf(err)}`);
			return [];
		});
		return {
			digest: running.digest,
			matches: tagsMatchingDigest(tags, running.digest, svc.tag),
			suggestion,
		};
	}

	/**
	 * Pins the service to `tag`. A registry tag just replaces the floating one,
	 * the image is the same so nothing needs redeploying. A local tag is made
	 * on this host from the running image first, and the pull policy moves to
	 * "missing" since no registry has it.
	 * @throws on an invalid tag, a service that isn't running an image, or a
	 *   failed tag call.
	 */
	async pin(
		svc: ServiceDTO,
		tag: string,
		options: { local: boolean },
	): Promise<void> {
		if (!isValidTag(tag)) {
			throw new Error(
				"A tag is letters, digits, '.', '_' and '-', up to 128 characters.",
			);
		}
		if (options.local) {
			const running = await this.#runningImage(svc);
			const source = running.imageId ?? `${svc.image}:${svc.tag}`;
			await DockerService.worker
				.post("v1/images/tag", { repository: svc.image, source, tag })
				.catch((err: unknown) => {
					throw isNotFound(err)
						? new Error(
								"The running image isn't on this host any more, deploy it again before pinning.",
							)
						: err;
				});
		}
		await svc.update({
			pinnedFromTag: svc.toJSON().pinnedFromTag ?? svc.tag,
			pinnedLocally: options.local,
			...(options.local ? { pullPolicy: "missing" as const } : {}),
			tag,
			updateCheck: null,
		});
		logger.info(`Pinned: service=${svc.id} tag=${tag} local=${options.local}`);
	}

	/** Puts the service back on the tag it was pinned from. Takes effect on the next deploy. */
	async unpin(svc: ServiceDTO): Promise<void> {
		const from = svc.toJSON().pinnedFromTag;
		if (!from) {
			return;
		}
		await svc.update({
			pinnedFromTag: null,
			pinnedLocally: false,
			...(svc.toJSON().pinnedLocally ? { pullPolicy: "always" as const } : {}),
			tag: from,
			updateCheck: null,
		});
		logger.info(`Unpinned: service=${svc.id} tag=${from}`);
	}

	/**
	 * Looks for an update: a newer stable release on the same track when the
	 * tag is a version (a locally made tag included, `1.25.0-dev-…` waits for
	 * `1.25.0`), or a new digest behind a floating tag like `latest`.
	 */
	async #findUpdate(svc: ServiceDTO): Promise<ImageUpdateAvailable | null> {
		const foundAt = new Date().toISOString();
		if (parseVersionTag(svc.tag)) {
			const tags = await ApiService.listTags(svc.image, {
				auth: DockerService.buildAuthConfig(svc.toJSON()),
				registryUrl: svc.registryUrl,
			});
			const newer = newerVersionTag(
				svc.tag,
				tags.map((tag) => tag.name),
			);
			if (!newer) {
				return null;
			}
			const digest =
				tags.find((tag) => tag.name === newer)?.digest ??
				(await ApiService.resolveDigest(
					svc.image,
					newer,
					svc.registryUrl,
					DockerService.buildAuthConfig(svc.toJSON()),
				));
			return { digest, foundAt, tag: newer };
		}
		if (svc.toJSON().pinnedLocally) {
			return null;
		}
		const [remote, running] = await Promise.all([
			ApiService.resolveDigest(
				svc.image,
				svc.tag,
				svc.registryUrl,
				DockerService.buildAuthConfig(svc.toJSON()),
			),
			this.#runningImage(svc),
		]);
		if (!(remote && running.digest) || remote === running.digest) {
			return null;
		}
		return { digest: remote, foundAt, tag: svc.tag };
	}

	/**
	 * Checks the registry for an update and records the outcome on the
	 * service. A new update is tried in a throwaway container first when the
	 * service has trials on, then notified once (in-app and to every channel
	 * subscribed to `update.available`). With `background`, returns as soon as
	 * the registry answered and leaves the trial and the notification running
	 * behind it, for a request that can't wait minutes. A check already in
	 * flight for the service isn't started twice. Never throws: a registry
	 * failure is recorded as the check's error.
	 */
	async check(
		svc: ServiceDTO,
		options: { background?: boolean } = {},
	): Promise<ImageUpdateState | null> {
		if (this.#inFlight.has(svc.id)) {
			return svc.toJSON().updateCheck;
		}
		this.#inFlight.add(svc.id);
		let finish: Promise<void> | null = null;
		try {
			const state = await this.#lookUp(svc);
			finish = this.#tryAndNotify(svc, state).finally(() => {
				this.#inFlight.delete(svc.id);
			});
			if (options.background) {
				finish.catch((err: unknown) => {
					logger.warn(`Update trial failed: service=${svc.id}`, err);
				});
			} else {
				await finish;
			}
			return state;
		} finally {
			if (!finish) {
				this.#inFlight.delete(svc.id);
			}
		}
	}

	/** Asks the registry for an update and records what it found, keeping the trial and notification of an update already seen. */
	async #lookUp(svc: ServiceDTO): Promise<ImageUpdateState> {
		const previous = svc.toJSON().updateCheck;
		const state: ImageUpdateState = {
			available: null,
			checkedAt: new Date().toISOString(),
			error: null,
			notifiedKey: previous?.notifiedKey ?? null,
			trial: null,
		};
		try {
			state.available = await this.#findUpdate(svc);
		} catch (err) {
			state.error = messageOf(err);
			state.available = previous?.available ?? null;
			state.trial = previous?.trial ?? null;
			logger.warn(`Update check failed: service=${svc.id} : ${state.error}`);
		}
		const available = state.available;
		const previousAvailable = previous?.available;
		if (
			!state.error &&
			available &&
			previousAvailable &&
			updateKey(previousAvailable) === updateKey(available)
		) {
			state.available = previousAvailable;
			state.trial =
				previous?.trial?.status === "running"
					? null
					: (previous?.trial ?? null);
		}
		await svc.update({ updateCheck: { ...state } });
		return state;
	}

	/** Runs the trial an update still needs, then notifies it once. */
	async #tryAndNotify(svc: ServiceDTO, state: ImageUpdateState): Promise<void> {
		const available = state.available;
		if (state.error || !available) {
			return;
		}
		if (svc.toJSON().updateTrialEnabled && !state.trial) {
			state.trial = await this.#trial(svc, available, state);
		}
		if (state.notifiedKey === updateKey(available)) {
			return;
		}
		this.#notify(svc, available, state.trial);
		state.notifiedKey = updateKey(available);
		await svc.update({ updateCheck: { ...state } });
	}

	/** Records a trial as running, runs it, then records and returns its outcome. */
	async #trial(
		svc: ServiceDTO,
		update: ImageUpdateAvailable,
		state: ImageUpdateState,
	): Promise<ImageUpdateTrial> {
		state.trial = {
			at: new Date().toISOString(),
			message: null,
			status: "running",
			tag: update.tag,
		};
		await svc.update({ updateCheck: { ...state } });
		let trial: ImageUpdateTrial;
		try {
			const message = await this.#runTrial(svc, update);
			trial = { ...state.trial, message, status: "passed" };
		} catch (err) {
			trial = {
				...state.trial,
				message: messageOf(err).slice(0, MAX_TRIAL_MESSAGE),
				status: "failed",
			};
		}
		trial.at = new Date().toISOString();
		state.trial = trial;
		await svc.update({ updateCheck: { ...state } });
		logger.info(
			`Update trial ${trial.status}: service=${svc.id} tag=${update.tag}`,
		);
		return trial;
	}

	/**
	 * Pulls the update and starts it in a container of its own, with the
	 * service's env, command and entrypoint but no volumes, no published
	 * ports, no Traefik labels and only Docker's default bridge network, so it
	 * can't touch the live service's data, its database or its traffic. Passes
	 * once the container reports healthy on the readiness check a real deploy
	 * would use, or is still running after `TRIAL_SETTLE_MS` when the service
	 * has healthchecks off. The container is
	 * always removed; the pulled image stays, ready for the real deploy.
	 * @returns A one-line summary of how it passed.
	 * @throws describing how it failed, with the container's last log lines.
	 */
	async #runTrial(
		svc: ServiceDTO,
		update: ImageUpdateAvailable,
	): Promise<string> {
		const auth = DockerService.buildAuthConfig(svc.toJSON());
		await DockerService.pullImage({
			auth,
			image: svc.image,
			tag: update.digest ? `${update.tag}@${update.digest}` : update.tag,
		});
		const ref = update.digest
			? `${svc.image}@${update.digest}`
			: `${svc.image}:${update.tag}`;
		const name = `homerun-trial-${svc.slug}`;
		await DockerService.worker
			.delete(`v1/containers/${name}`, { force: "1" })
			.catch(() => undefined);
		const created = await DockerService.worker.post<{ id: string }>(
			"v1/containers",
			{
				body: {
					Cmd: svc.command ?? undefined,
					Entrypoint: svc.toJSON().entrypoint ?? undefined,
					Env: Object.entries(svc.envVars).map(
						([key, value]) => `${key}=${value}`,
					),
					HostConfig: {
						NetworkMode: "bridge",
						RestartPolicy: { Name: "no" },
					},
					Healthcheck: this.#trialHealthcheck(svc),
					Image: ref,
					Labels: { [TRIAL_LABEL]: svc.id },
				},
				name,
			},
		);
		try {
			await DockerService.worker.post(`v1/containers/${created.id}/start`);
			return await this.#watchTrial(created.id);
		} catch (err) {
			const logs = await this.#trialLogs(created.id);
			throw new Error(logs ? `${messageOf(err)}\n\n${logs}` : messageOf(err));
		} finally {
			await DockerService.worker
				.delete(`v1/containers/${created.id}`, { force: "1" })
				.catch(() => undefined);
		}
	}

	/** The readiness check a real deploy would gate traffic on: the service's own healthcheck command, else a wait for its port to listen, none when healthchecks are off. */
	#trialHealthcheck(svc: ServiceDTO): object | undefined {
		const row = svc.toJSON();
		if (row.healthcheckDisabled) {
			return;
		}
		const timing = healthcheckTimingOf(row);
		return (
			dockerHealthcheck(row.healthcheckCommand, timing) ??
			listeningHealthcheck(row.containerPort, timing)
		);
	}

	/** Polls a trial container until it's healthy, settled or dead, giving up `TRIAL_HEALTH_TIMEOUT_MS` after `started`. */
	async #watchTrial(id: string, started = Date.now()): Promise<string> {
		if (Date.now() - started >= TRIAL_HEALTH_TIMEOUT_MS) {
			throw new Error("The new version never reported healthy.");
		}
		await sleep(TRIAL_POLL_MS);
		const inspected = await DockerService.worker.get<TrialInspect>(
			`v1/containers/${id}/inspect`,
		);
		const state = inspected.State ?? {};
		if (state.Restarting || !state.Running) {
			throw new Error(
				`The new version exited with code ${state.ExitCode ?? "unknown"}.`,
			);
		}
		const health = state.Health?.Status;
		if (health === "healthy") {
			return "Reported healthy.";
		}
		if (health === "unhealthy") {
			throw new Error("The new version failed its healthcheck.");
		}
		if (!health && Date.now() - started >= TRIAL_SETTLE_MS) {
			return `Still running after ${TRIAL_SETTLE_MS / 1000}s.`;
		}
		return this.#watchTrial(id, started);
	}

	/** The last lines a trial container logged, or "" when they can't be read. */
	async #trialLogs(id: string): Promise<string> {
		try {
			const stream = await DockerService.streamLogs(id, {
				follow: false,
				tail: TRIAL_LOG_LINES,
			});
			return stripAnsi(await new Response(stream).text()).trim();
		} catch {
			return "";
		}
	}

	/** Notifies an available update in-app and to the channels subscribed to `update.available`. */
	#notify(
		svc: ServiceDTO,
		update: ImageUpdateAvailable,
		trial: ImageUpdateTrial | null,
	): void {
		const target =
			update.tag === svc.tag ? `a newer ${update.tag} image` : update.tag;
		const outcome = trial
			? trial.status === "passed"
				? " Its trial run started cleanly."
				: " Its trial run failed."
			: "";
		NotificationDTO.notify({
			detail: trial?.status === "failed" ? trial.message : null,
			message: `"${svc.name}" can update to ${target}.${outcome}`,
			serviceId: svc.id,
			type: "update_available",
		});
		NotificationChannelService.notify(
			updateAvailableMessage(
				{
					currentTag: svc.tag,
					image: svc.image,
					origin: config.auth.origin ?? null,
					service: { id: svc.id, name: svc.name },
					trial,
					update,
				},
				new Date().toISOString(),
			),
		);
	}

	/**
	 * Moves the service onto its available update and enqueues the deploy. A
	 * new release of a pinned service stays pinned, to the new tag; a local
	 * pin goes back to pulling since the new tag is a published one.
	 * @throws when there's no update to apply.
	 */
	async applyUpdate(svc: ServiceDTO, userId: string): Promise<void> {
		const available = svc.toJSON().updateCheck?.available;
		if (!available) {
			throw new Error("There's no update to apply.");
		}
		const wasLocal = svc.toJSON().pinnedLocally;
		await svc.update({
			pinnedLocally: false,
			...(wasLocal ? { pullPolicy: "always" as const } : {}),
			tag: available.tag,
			updateCheck: null,
		});
		await DeploymentService.enqueueDeploy({
			note: `Updating to ${svc.image}:${available.tag}`,
			svc,
			userId,
		});
		logger.info(`Update applied: service=${svc.id} tag=${available.tag}`);
	}
}

export const ImageVersionService = new ImageVersionServiceClass();
