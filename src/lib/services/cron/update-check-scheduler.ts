import { ServiceDTO } from "#lib/dto/service-dto.js";
import { ImageVersionService } from "../image-version.service.ts";
import { BaseScheduler } from "./base-scheduler.ts";

const TICK_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export class UpdateCheckScheduler extends BaseScheduler {
	protected readonly label = "Updates";

	protected readonly intervalMs = TICK_MS;

	/**
	 * Checks every service that opted into update checks and hasn't been
	 * checked in `CHECK_EVERY_MS`, one at a time so trial runs never pile up
	 * on the host.
	 */
	protected async tick(): Promise<void> {
		const now = Date.now();
		const due = (await ServiceDTO.list()).filter((svc) => {
			const row = svc.toJSON();
			const checkedAt = row.updateCheck?.checkedAt;
			return (
				row.updateCheckEnabled &&
				row.buildSource === "image" &&
				!row.previewParentId &&
				(!checkedAt || now - Date.parse(checkedAt) >= CHECK_EVERY_MS)
			);
		});
		await due.reduce<Promise<unknown>>(
			(previous, svc) => previous.then(() => ImageVersionService.check(svc)),
			Promise.resolve(),
		);
	}
}
