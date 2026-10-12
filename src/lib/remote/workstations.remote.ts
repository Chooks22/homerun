import { error } from "@sveltejs/kit";
import { z } from "zod";
import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { requirePermission } from "#lib/server/remote-auth.js";
import {
	WorkstationService,
	type WorkstationView,
} from "#lib/services/workstation.service.js";
import type { WorkstationCheck } from "#lib/workstation-self-test.js";
import { command, query } from "$app/server";

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
