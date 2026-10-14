import { config } from "#lib/config.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import {
	WorkstationPresetDTO,
	type WorkstationPresetInput,
} from "#lib/dto/workstation-preset-dto.js";
import { Logger } from "#lib/logger.js";
import { hostnameOwner } from "#lib/server/hostname-owner.js";
import {
	generateWorkstationPassword,
	type WorkstationSettings,
} from "#lib/server/workstation-form.js";
import { agentHostProblem } from "#lib/server/workstation-presets.js";
import { encryptSecret } from "#lib/services/secrets.js";
import { WorkstationService } from "#lib/services/workstation.service.js";
import { slugify, uniqueSlug } from "#lib/slug.js";
import {
	type AutoStopMode,
	DEFAULT_WORKSTATION_HOME,
	DEFAULT_WORKSTATION_IMAGE,
	DEFAULT_WORKSTATION_PORT,
	defaultWorkstationDomain,
} from "#lib/workstations.js";

const logger = new Logger("Workstation");

/** A workstation or preset change refused for the caller's input, with the status to answer; nothing was saved. */
export class WorkstationSettingsError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

const DEFAULT_SETTINGS: WorkstationSettings = {
	cpuLimit: null,
	editorSettings: {},
	env: {},
	extensions: [],
	gitAuthorEmail: null,
	gitAuthorName: null,
	gitBranch: null,
	gitProviderId: null,
	gitUrl: null,
	homePath: DEFAULT_WORKSTATION_HOME,
	image: DEFAULT_WORKSTATION_IMAGE,
	memoryLimitMb: null,
	port: DEFAULT_WORKSTATION_PORT,
};

/** What a new workstation is made of: its settings (defaults fill the rest), a name, and the domain and host it can't change later. */
export interface NewWorkstation extends Partial<WorkstationSettings> {
	domain?: string | null;
	name: string;
	remoteHostId?: string | null;
}

/** Auto-stop as the Overview sets it: a mode with its minutes, or null mode for off. */
export interface AutoStopSetting {
	minutes: number | null;
	mode: AutoStopMode | null;
}

/** A change to a workstation: its name, settings, auto-stop and whether it should run. */
export interface WorkstationPatch extends Partial<WorkstationSettings> {
	autoStop?: AutoStopSetting;
	desiredState?: "running" | "stopped";
	name?: string;
}

/** The auto-stop setting, checked to carry its minutes when it's on. */
function checkedAutoStop(setting: AutoStopSetting): AutoStopSetting {
	if (setting.mode && !setting.minutes) {
		throw new WorkstationSettingsError("Give the auto-stop delay in minutes.");
	}
	return setting.mode ? setting : { minutes: null, mode: null };
}

/** Throws when `remoteHostId` can't run a workstation. */
async function checkHost(remoteHostId: string | null | undefined) {
	const problem = await agentHostProblem(remoteHostId ?? null);
	if (problem) {
		throw new WorkstationSettingsError(problem);
	}
}

/**
 * Creating and editing workstations and their presets, shared by the
 * Workstations pages and the REST API. Both are personal: callers pass the
 * owner's id and the rows they got from the owner-scoped finders.
 */
class WorkstationSettingsServiceClass {
	/**
	 * Creates a workstation for `userId` on a free slug and hostname, applies
	 * `options.autoStop`, then starts it unless `options.start` is false. A
	 * start that fails is logged and left on the workstation's last error.
	 *
	 * @throws {WorkstationSettingsError} When the host can't run a
	 *   workstation (400), or the hostname is already routed (409).
	 */
	async create(
		userId: string,
		input: NewWorkstation,
		options: { autoStop?: AutoStopSetting; start?: boolean } = {},
	): Promise<WorkstationDTO> {
		const { domain, name, remoteHostId = null, ...settings } = input;
		await checkHost(remoteHostId);
		const autoStop = options.autoStop && checkedAutoStop(options.autoStop);
		const slug = await uniqueSlug(slugify(name) || "workstation", (candidate) =>
			WorkstationDTO.slugTaken(candidate),
		);
		const hostname =
			domain?.replace(/\.$/, "") ||
			defaultWorkstationDomain(slug, config.baseDomain);
		const owner = await hostnameOwner(hostname);
		if (owner) {
			throw new WorkstationSettingsError(
				`${hostname} is already routed to ${owner}. Pick another domain for the workstation.`,
				409,
			);
		}
		const ws = await WorkstationDTO.create({
			...DEFAULT_SETTINGS,
			...settings,
			domain: hostname,
			name,
			passwordEnc: encryptSecret(generateWorkstationPassword()),
			remoteHostId,
			slug,
			userId,
		});
		logger.info(
			`Workstation created: workstation=${ws.id} host=${remoteHostId ?? "local"} user=${userId}`,
		);
		if (autoStop) {
			await WorkstationService.setAutoStop(ws, autoStop.mode, autoStop.minutes);
		}
		if (options.start !== false) {
			await WorkstationService.start(ws).catch((error: unknown) => {
				logger.warn(
					`Workstation created but didn't start: workstation=${ws.id}`,
					error,
				);
			});
		}
		return ws;
	}

	/**
	 * Saves the fields sent, then the auto-stop setting, then starts or stops
	 * the workstation when `desiredState` asks for the other state. A change
	 * to a running workstation's settings applies on its next start.
	 *
	 * @throws {WorkstationSettingsError} When the auto-stop setting has no
	 *   minutes.
	 * @throws When the worker or agent refuses a start or a stop.
	 */
	async update(ws: WorkstationDTO, patch: WorkstationPatch): Promise<void> {
		const { autoStop, desiredState, ...columns } = patch;
		const checked = autoStop && checkedAutoStop(autoStop);
		if (Object.keys(columns).length > 0) {
			await ws.update(columns);
			logger.info(`Workstation settings saved: workstation=${ws.id}`);
		}
		if (checked) {
			await WorkstationService.setAutoStop(ws, checked.mode, checked.minutes);
		}
		if (desiredState === "running" && ws.desiredState !== "running") {
			await WorkstationService.start(ws);
		} else if (desiredState === "stopped" && ws.desiredState !== "stopped") {
			await WorkstationService.stop(ws);
		}
	}

	/**
	 * Saves a preset for `userId`, defaults filling the settings left out.
	 *
	 * @throws {WorkstationSettingsError} When its host can't run a workstation.
	 */
	async createPreset(
		userId: string,
		input: Partial<WorkstationPresetInput> & { name: string },
	): Promise<WorkstationPresetDTO> {
		await checkHost(input.remoteHostId);
		const preset = await WorkstationPresetDTO.create(userId, {
			...DEFAULT_SETTINGS,
			description: null,
			remoteHostId: null,
			...input,
		});
		logger.info(
			`Workstation preset created: preset=${preset.id} user=${userId}`,
		);
		return preset;
	}

	/**
	 * Saves the preset fields sent, keeping the rest.
	 *
	 * @throws {WorkstationSettingsError} When its new host can't run a
	 *   workstation.
	 */
	async updatePreset(
		preset: WorkstationPresetDTO,
		input: Partial<WorkstationPresetInput>,
	): Promise<void> {
		if (input.remoteHostId !== undefined) {
			await checkHost(input.remoteHostId);
		}
		if (Object.keys(input).length === 0) {
			return;
		}
		await preset.update(input);
		logger.info(`Workstation preset saved: preset=${preset.id}`);
	}
}

export const WorkstationSettingsService = new WorkstationSettingsServiceClass();
