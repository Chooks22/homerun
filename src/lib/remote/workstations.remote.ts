import { error } from "@sveltejs/kit";
import { z } from "zod";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { requirePermission } from "#lib/server/remote-auth.js";
import type { ContainerSample } from "#lib/services/docker/containers.js";
import { type EditorExtension, searchOpenVsx } from "#lib/services/open-vsx.js";
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
