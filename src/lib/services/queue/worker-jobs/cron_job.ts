import { z } from "zod";
import { config } from "#lib/config.js";
import { CronJobDTO } from "#lib/dto/cron-job-dto.js";
import type { JobDTO } from "#lib/dto/job-dto.js";
import { CronJobService } from "../../cron-job.service.ts";
import { NotificationChannelService } from "../../notification-channel.service.ts";
import { cronJobMessage } from "../../notification-messages.ts";
import { cronJobPayload } from "../payloads.ts";
import type { WorkerJob } from "./types.ts";

const executionSchema = z.object({
	exitCode: z.number(),
	output: z.string(),
	timedOut: z.boolean(),
});

const specSchema = z.object({ runId: z.string() });

async function cronJobFor(entry: JobDTO): Promise<CronJobDTO> {
	const { cronJobId } = cronJobPayload.parse(entry.payload);
	const job = await CronJobDTO.get(cronJobId);
	if (!job) {
		throw new Error("The cron job was deleted before it ran.");
	}
	return job;
}

export const cronJobWorkerJob: WorkerJob | null = {
	async finalize(entry, result, error) {
		const job = await cronJobFor(entry);
		const { scheduled } = cronJobPayload.parse(entry.payload);
		const { runId } = specSchema.parse(entry.decryptSpec());
		const outcome = await CronJobService.finishRun(
			job,
			runId,
			result ? executionSchema.parse(result) : null,
			error,
		);
		NotificationChannelService.notify(
			cronJobMessage(
				{
					job: { id: job.id, name: job.name },
					origin: config.auth.origin ?? null,
					outcome,
					scheduled,
				},
				new Date().toISOString(),
			),
			{ scheduled },
		);
		if (!outcome.success) {
			throw new Error(outcome.error ?? "The cron job failed.");
		}
		return { exitCode: outcome.exitCode };
	},
	async prepare(entry) {
		const { scheduled } = cronJobPayload.parse(entry.payload);
		return CronJobService.prepareRun(await cronJobFor(entry), {
			jobId: entry.id,
			trigger: scheduled ? "cron" : "manual",
		});
	},
};
