import { fail } from "@sveltejs/kit";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { BASE_SORTS, sortKeysOf } from "#lib/list-sorts.js";
import { Logger } from "#lib/logger.js";
import { parseListQuery } from "#lib/server/list-query.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { CronService } from "#lib/services/cron.service.js";

const logger = new Logger("Storage");

const BULK_OPS = ["delete", "disableBackup", "enableBackup"] as const;

type BulkOp = (typeof BULK_OPS)[number];

function backupConfigured(vol: StorageVolumeDTO): boolean {
	return (
		!!vol.s3DestinationId &&
		!!CronService.parseCronSchedule(vol.backupSchedule ?? "")
	);
}

async function runOp(
	op: BulkOp,
	vol: StorageVolumeDTO,
	userId: string,
): Promise<"done" | "skipped"> {
	if (op === "delete") {
		await vol.delete();
		logger.info(`Storage volume deleted: volume=${vol.id} user=${userId}`);
		return "done";
	}
	const backupEnabled = op === "enableBackup";
	if (backupEnabled && !backupConfigured(vol)) {
		return "skipped";
	}
	await vol.update({ backupEnabled });
	logger.info(
		`Backup ${backupEnabled ? "enabled" : "disabled"}: volume=${vol.id} user=${userId}`,
	);
	return "done";
}

async function runBulk(formData: FormData, userId: string) {
	const op = formData.get("op");
	if (typeof op !== "string" || !BULK_OPS.includes(op as BulkOp)) {
		return fail(400, { error: "Unknown bulk action." });
	}
	const ids = formData
		.getAll("volumeId")
		.filter((v): v is string => typeof v === "string" && v.length > 0);
	if (ids.length === 0) {
		return fail(400, { error: "No volumes selected." });
	}

	const found = (
		await Promise.all(ids.map((id) => StorageVolumeDTO.get(id)))
	).filter((vol): vol is StorageVolumeDTO => vol !== null);
	const settled = await Promise.allSettled(
		found.map((vol) => runOp(op as BulkOp, vol, userId)),
	);

	const succeeded = settled.filter(
		(r) => r.status === "fulfilled" && r.value === "done",
	).length;
	const skipped = settled.filter(
		(r) => r.status === "fulfilled" && r.value === "skipped",
	).length;
	const failed = ids.length - succeeded - skipped;

	if (succeeded === 0 && skipped === 0) {
		const firstRejection = settled.find((r) => r.status === "rejected");
		return fail(400, {
			error:
				firstRejection?.reason instanceof Error
					? firstRejection.reason.message
					: "Couldn't update the selected volumes.",
		});
	}
	return { failed, op, skipped, succeeded, success: true };
}

export const load = async ({ parent, url }) => {
	const { preferences } = await parent();
	const query = parseListQuery(
		url,
		{
			filterKeys: ["kind", "backup"],
			sortKeys: sortKeysOf(BASE_SORTS),
		},
		preferences.perPage,
	);
	const paged = await StorageVolumeDTO.listPaged(query);

	return {
		filtered: query.active,
		page: paged.page,
		perPage: paged.perPage,
		total: paged.total,
		volumes: paged.items.map((v) => v.toJSON()),
	};
};

export const actions = {
	delete: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const data = await request.formData();
		const volumeId = data.get("volumeId") as string | null;
		if (!volumeId) {
			return fail(400, { error: "Missing volume id." });
		}

		const vol = await StorageVolumeDTO.get(volumeId);
		if (!vol) {
			return fail(404, { error: "Volume not found." });
		}

		await vol.delete();
		logger.info(
			`Storage volume deleted: volume=${volumeId} user=${locals.user.id}`,
		);
		return { success: true };
	},

	bulk: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		return runBulk(await request.formData(), locals.user.id);
	},
};
