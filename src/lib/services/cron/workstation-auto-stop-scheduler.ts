import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { WorkstationService } from "../workstation.service.ts";
import { BaseScheduler } from "./base-scheduler.ts";

/** Per-minute pass stopping workstations whose auto-stop deadline passed. */
export class WorkstationAutoStopScheduler extends BaseScheduler {
	protected readonly label: string;

	/** Ticks every minute under the `WorkstationAutoStop` label. */
	constructor() {
		super();
		this.label = "WorkstationAutoStop";
	}

	/** Runs `WorkstationService.autoStop` over every running workstation with an auto-stop set, one failure not holding up the rest. */
	protected async tick(): Promise<void> {
		const now = new Date();
		const workstations = await WorkstationDTO.listAutoStopping();
		await Promise.all(
			workstations.map((ws) =>
				WorkstationService.autoStop(ws, now).catch((error: unknown) => {
					this.logger.error(
						`Workstation auto-stop failed: workstation=${ws.id}`,
						error,
					);
				}),
			),
		);
	}
}
