import { error } from "@sveltejs/kit";
import { z } from "zod";
import {
	DEVCONTAINER_PATHS,
	type DevcontainerConfig,
	parseDevcontainer,
	repoPathOf,
} from "#lib/devcontainer.js";
import { GitConnectionDTO } from "#lib/dto/git-connection-dto.js";
import { InstanceSettingsDTO } from "#lib/dto/instance-settings-dto.js";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { providerForGitUrl } from "#lib/git-clone-url.js";
import { Logger } from "#lib/logger.js";
import { hostnameOwner } from "#lib/server/hostname-owner.js";
import { requirePermission } from "#lib/server/remote-auth.js";
import type { ContainerSample } from "#lib/services/docker/containers.js";
import { GitProviderService } from "#lib/services/git-provider.service.js";
import { type EditorExtension, searchOpenVsx } from "#lib/services/open-vsx.js";
import {
	fetchSyncedEditor,
	type SyncedEditor,
} from "#lib/services/vscode-settings-sync.js";
import {
	WorkstationService,
	type WorkstationView,
} from "#lib/services/workstation.service.js";
import type { WorkstationCheck } from "#lib/workstation-self-test.js";
import { command, query } from "$app/server";

const logger = new Logger("Workstation");

export const workstationStatus = query(
	z.string(),
	async (workstationId): Promise<WorkstationView> => {
		const user = requirePermission("workstations", "read");
		const ws = await WorkstationDTO.get(workstationId, user.id);
		if (!ws) {
			error(404, "Workstation not found.");
		}
		return await WorkstationService.view(ws);
	},
);

export const detectDevcontainer = query(
	z.object({ branch: z.string(), gitUrl: z.string() }),
	async ({ branch, gitUrl }): Promise<DevcontainerConfig | null> => {
		const user = requirePermission("workstations", "read");
		const repo = repoPathOf(gitUrl);
		if (!repo) {
			return null;
		}
		const settings = await InstanceSettingsDTO.get();
		const provider = providerForGitUrl(
			gitUrl,
			settings.gitProviders.filter((p) => p.enabled),
		);
		const connection = provider
			? await GitConnectionDTO.getForUserAndProvider(user.id, provider.id)
			: null;
		if (!(provider && connection)) {
			return null;
		}
		const found = await Promise.all(
			DEVCONTAINER_PATHS.map(async (path) => ({
				path,
				text: await GitProviderService.readFile(provider, connection, {
					path,
					ref: branch,
					repo,
				}),
			})),
		);
		const hit = found.find((file) => file.text !== null);
		return hit?.text ? parseDevcontainer(hit.text, hit.path) : null;
	},
);

export const workstationDomainOwner = query(
	z.string().trim().toLowerCase().max(253),
	async (domain): Promise<string | null> => {
		requirePermission("workstations", "read");
		return domain ? await hostnameOwner(domain) : null;
	},
);

export const testWorkstation = command(
	z.string(),
	async (workstationId): Promise<WorkstationCheck[]> => {
		const user = requirePermission("workstations", "read");
		const ws = await WorkstationDTO.get(workstationId, user.id);
		if (!ws) {
			error(404, "Workstation not found.");
		}
		return await WorkstationService.selfTest(ws);
	},
);

export const searchEditorExtensions = query(
	z.string().trim().max(100),
	async (search): Promise<EditorExtension[]> => {
		requirePermission("workstations", "read");
		if (search.length < 2) {
			return [];
		}
		try {
			return await searchOpenVsx(search);
		} catch (err) {
			logger.warn(`Open VSX search failed: query=${search}`, err);
			error(502, "Couldn't reach Open VSX.");
		}
	},
);

export const importSettingsSync = command(async (): Promise<SyncedEditor> => {
	const user = requirePermission("workstations", "read");
	const settings = await InstanceSettingsDTO.get();
	const providers = settings.gitProviders.filter(
		(p) => p.enabled && p.kind === "github" && !p.baseUrl,
	);
	const connections = await Promise.all(
		providers.map(async (provider) => ({
			connection: await GitConnectionDTO.getForUserAndProvider(
				user.id,
				provider.id,
			),
			provider,
		})),
	);
	const linked = connections.find((entry) => entry.connection);
	const token = linked?.connection
		? await GitProviderService.accessToken(linked.provider, linked.connection)
		: null;
	if (!token) {
		error(
			400,
			"Connect a github.com account under Git providers to import from Settings Sync.",
		);
	}
	try {
		return await fetchSyncedEditor(token);
	} catch (err) {
		logger.warn(`Settings Sync import failed: user=${user.id}`, err);
		error(
			502,
			err instanceof Error ? err.message : "Couldn't reach Settings Sync.",
		);
	}
});

export const workstationLiveStats = query(
	z.string(),
	async (workstationId): Promise<ContainerSample | null> => {
		const user = requirePermission("workstations", "read");
		const ws = await WorkstationDTO.get(workstationId, user.id);
		if (!ws) {
			error(404, "Workstation not found.");
		}
		if (ws.desiredState !== "running") {
			return null;
		}
		return await WorkstationService.stats(ws).catch(() => null);
	},
);

export const workstationDiskUsage = query(
	z.string(),
	async (workstationId): Promise<number | null> => {
		const user = requirePermission("workstations", "read");
		const ws = await WorkstationDTO.get(workstationId, user.id);
		if (!ws) {
			error(404, "Workstation not found.");
		}
		if (ws.desiredState !== "running") {
			return null;
		}
		try {
			return await WorkstationService.diskUsage(ws);
		} catch (err) {
			logger.warn(
				`Couldn't measure a workstation's home: workstation=${ws.id}`,
				err,
			);
			return null;
		}
	},
);
