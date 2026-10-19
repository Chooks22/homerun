import { z } from "zod";
import {
	configFromImage,
	type DetectedConfig,
	type OciImageConfig,
} from "#lib/image-config.js";
import { Logger } from "#lib/logger.js";
import { requirePermission } from "#lib/server/remote-auth.js";
import { ApiService } from "#lib/services/api.service.js";
import { DockerService } from "#lib/services/docker.service.js";
import { query } from "$app/server";

export interface ImageCheck {
	checked: boolean;
	exists: boolean;
}

const imageCheckInput = z.object({
	image: z.string(),
	registryPassword: z.string().optional(),
	registryUrl: z.string().optional(),
	registryUsername: z.string().optional(),
	tag: z.string().optional(),
});

const logger = new Logger("Docker");

export const checkImage = query(
	imageCheckInput,
	async (input): Promise<ImageCheck> => {
		requirePermission("services", "read");

		const image = input.image.trim();
		if (!image) {
			return { checked: false, exists: true };
		}

		const tag = input.tag?.trim() || "latest";
		const registryUrl = input.registryUrl?.trim() || null;
		const username = input.registryUsername?.trim();
		const auth = username
			? { password: input.registryPassword ?? "", username }
			: undefined;

		return await ApiService.checkImageExists(image, tag, registryUrl, auth);
	},
);

export const inspectImageConfig = query(
	imageCheckInput,
	async (input): Promise<DetectedConfig | null> => {
		requirePermission("services", "read");

		const image = input.image.trim();
		if (!image) {
			return null;
		}
		const tag = input.tag?.trim() || "latest";
		const registryUrl = input.registryUrl?.trim() || null;
		const username = input.registryUsername?.trim();
		const auth = username
			? { password: input.registryPassword ?? "", username }
			: undefined;

		const remote = await ApiService.fetchImageConfig(
			image,
			tag,
			registryUrl,
			auth,
		).catch((err: unknown) => {
			logger.warn(`Image config lookup failed: ${image}:${tag}`, err);
			return null;
		});
		if (remote) {
			return configFromImage(remote);
		}
		const ref = registryUrl
			? `${registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}/${image}:${tag}`
			: `${image}:${tag}`;
		const local = await DockerService.worker
			.get<{ Config?: OciImageConfig | null }>("v1/images/inspect", { ref })
			.catch(() => null);
		return local?.Config ? configFromImage(local.Config) : null;
	},
);
