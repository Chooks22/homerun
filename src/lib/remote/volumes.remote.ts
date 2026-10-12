import { error } from "@sveltejs/kit";
import { z } from "zod";
import { requirePermission } from "#lib/server/remote-auth.js";
import {
	VolumeSettingsError,
	VolumeSettingsService,
} from "#lib/services/volume-settings.service.js";
import { command } from "$app/server";

/**
 * Registers a storage volume (a host path or a Docker volume) the same way
 * Storage → New volume does, for a form that picks volumes and wants a new one
 * without leaving the page.
 *
 * @throws A 400 error with the reason when a field is invalid; nothing is
 * created then.
 */
export const createStorageVolume = command(
	z.object({
		description: z.string().max(2000).nullable(),
		kind: z.enum(["bind", "volume"]),
		name: z.string().max(200),
		source: z.string().max(4096),
	}),
	async (input): Promise<{ id: string; name: string }> => {
		const user = requirePermission("storage", "write");
		try {
			const volume = await VolumeSettingsService.create(input, user.id);
			return { id: volume.id, name: volume.name };
		} catch (err) {
			if (err instanceof VolumeSettingsError) {
				error(400, err.message);
			}
			throw err;
		}
	},
);
