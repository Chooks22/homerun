import { error, fail } from "@sveltejs/kit";
import { StorageVolumeDTO } from "#lib/dto/storage-volume-dto.js";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { VolumeFilesService } from "#lib/services/volume-files.service.js";
import {
	isEntryName,
	isOctalMode,
	MAX_EDITABLE_BYTES,
	normalizeVolumePath,
} from "#lib/volume-files.js";

const logger = new Logger("Storage");

const failure = (err: unknown, fallback: string) =>
	fail(500, { error: err instanceof Error ? err.message : fallback });

export const load = async ({ params, parent, url }) => {
	await parent();
	const volume = await StorageVolumeDTO.get(params.volumeId);
	if (!volume) {
		error(404, "Volume not found");
	}
	const rawFile = url.searchParams.get("file");
	const path = normalizeVolumePath(url.searchParams.get("path") ?? "");
	const filePath = rawFile === null ? null : normalizeVolumePath(rawFile);
	if (path === null || (rawFile !== null && filePath === null)) {
		return {
			error: "That path leaves the volume.",
			file: null,
			listing: null,
			path: "",
		};
	}

	try {
		if (filePath !== null) {
			const file = await VolumeFilesService.read(volume, filePath);
			return {
				error: null,
				file: { ...file, path: filePath },
				listing: null,
				path,
			};
		}
		const listing = await VolumeFilesService.list(volume, path);
		return { error: null, file: null, listing, path };
	} catch (err) {
		return {
			error: err instanceof Error ? err.message : "Couldn't read the volume.",
			file: null,
			listing: null,
			path,
		};
	}
};

export const actions = {
	save: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const volume = await StorageVolumeDTO.get(params.volumeId);
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}
		const formData = await request.formData();
		const path = normalizeVolumePath(String(formData.get("path") ?? ""));
		const content = String(formData.get("content") ?? "");
		if (path === null) {
			return fail(400, { error: "That path leaves the volume." });
		}
		if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_BYTES) {
			return fail(400, { error: "The file is too big to save from here." });
		}
		try {
			await VolumeFilesService.write(volume, path, content);
		} catch (err) {
			return fail(500, {
				error: err instanceof Error ? err.message : "Couldn't save the file.",
			});
		}
		logger.info(
			`Volume file saved: volume=${volume.id} path=/${path} user=${locals.user.id}`,
		);
		return { success: true };
	},
	create: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const volume = await StorageVolumeDTO.get(params.volumeId);
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}
		const formData = await request.formData();
		const kind = formData.get("kind") === "directory" ? "directory" : "file";
		const name = String(formData.get("name") ?? "").trim();
		if (!isEntryName(name)) {
			return fail(400, { error: "Give it a plain name, without slashes." });
		}
		const path = normalizeVolumePath(
			`${String(formData.get("dir") ?? "")}/${name}`,
		);
		if (path === null) {
			return fail(400, { error: "That path leaves the volume." });
		}
		try {
			await VolumeFilesService.create(volume, path, kind);
		} catch (err) {
			return failure(err, "Couldn't create it.");
		}
		logger.info(
			`Volume ${kind} created: volume=${volume.id} path=/${path} user=${locals.user.id}`,
		);
		return { kind, path };
	},
	delete: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const volume = await StorageVolumeDTO.get(params.volumeId);
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}
		const formData = await request.formData();
		const path = normalizeVolumePath(String(formData.get("path") ?? ""));
		if (!path) {
			return fail(400, { error: "That path can't be deleted." });
		}
		try {
			await VolumeFilesService.remove(volume, path);
		} catch (err) {
			return failure(err, "Couldn't delete it.");
		}
		logger.info(
			`Volume entry deleted: volume=${volume.id} path=/${path} user=${locals.user.id}`,
		);
		return { success: true };
	},
	chmod: async ({ request, params, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const volume = await StorageVolumeDTO.get(params.volumeId);
		if (!volume) {
			return fail(404, { error: "Volume not found." });
		}
		const formData = await request.formData();
		const path = normalizeVolumePath(String(formData.get("path") ?? ""));
		const mode = String(formData.get("mode") ?? "").trim();
		if (path === null) {
			return fail(400, { error: "That path leaves the volume." });
		}
		if (!isOctalMode(mode)) {
			return fail(400, {
				error: "The mode must be 3 or 4 octal digits, like 644.",
			});
		}
		try {
			await VolumeFilesService.chmod(volume, path, mode);
		} catch (err) {
			return failure(err, "Couldn't change the permissions.");
		}
		logger.info(
			`Volume entry chmod ${mode}: volume=${volume.id} path=/${path} user=${locals.user.id}`,
		);
		return { mode };
	},
};
