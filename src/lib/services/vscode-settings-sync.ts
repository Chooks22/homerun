import { z } from "zod";
import { stripJsonc } from "#lib/devcontainer.js";
import { openVsxHas } from "#lib/services/open-vsx.js";
import { EXTENSION_ID_RE } from "#lib/workstations.js";

const SYNC_STORE_URL = "https://vscode-sync.trafficmanager.net";

/** What VS Code's Settings Sync holds for a GitHub account, as a workstation's Editor section takes it. */
export interface SyncedEditor {
	extensions: string[];
	missingExtensions: string[];
	settings: Record<string, unknown> | null;
}

const syncDataSchema = z.object({
	content: z.string(),
	version: z.number(),
});

const syncExtensionsSchema = z.array(
	z.object({
		disabled: z.boolean().optional(),
		identifier: z.object({ id: z.string() }),
		installed: z.boolean().optional(),
	}),
);

/**
 * The `content` of a Settings Sync resource body, null when nothing was
 * synced.
 *
 * @throws When the body isn't Settings Sync data.
 */
function syncContent(
	body: string,
): { content: string; version: number } | null {
	if (!body.trim()) {
		return null;
	}
	return syncDataSchema.parse(JSON.parse(body));
}

/**
 * The enabled, user-installed extension ids in a Settings Sync `extensions`
 * resource body, lowercased. Builtin extensions (synced only for their
 * enabled state) and disabled ones are dropped; sync data older than v3
 * can't tell builtins apart, so every enabled entry is kept.
 *
 * @throws When the body isn't Settings Sync data.
 */
export function parseSyncedExtensions(body: string): string[] {
	const data = syncContent(body);
	if (!data) {
		return [];
	}
	const entries = syncExtensionsSchema.parse(JSON.parse(data.content));
	const ids = entries
		.filter((ext) => !ext.disabled && (data.version < 3 || ext.installed))
		.map((ext) => ext.identifier.id.toLowerCase())
		.filter((id) => EXTENSION_ID_RE.test(id));
	return [...new Set(ids)];
}

/**
 * The user `settings.json` in a Settings Sync `settings` resource body, its
 * comments and trailing commas stripped, null when nothing was synced or the
 * synced file is empty.
 *
 * @throws When the body isn't Settings Sync data or the synced file isn't a
 * JSON object.
 */
export function parseSyncedSettings(
	body: string,
): Record<string, unknown> | null {
	const data = syncContent(body);
	if (!data) {
		return null;
	}
	const wrapped: unknown = JSON.parse(data.content);
	const text =
		typeof wrapped === "object" &&
		wrapped !== null &&
		"settings" in wrapped &&
		typeof wrapped.settings === "string"
			? wrapped.settings
			: data.content;
	const stripped = stripJsonc(text).trim();
	if (!stripped) {
		return null;
	}
	const settings = z
		.record(z.string(), z.unknown())
		.parse(JSON.parse(stripped));
	return Object.keys(settings).length > 0 ? settings : null;
}

/**
 * GETs one resource's latest Settings Sync body with a GitHub token.
 *
 * @throws When the sync store rejects the token or can't be reached.
 */
async function readResource(
	githubToken: string,
	resource: "extensions" | "settings",
): Promise<string> {
	const response = await fetch(
		`${SYNC_STORE_URL}/v1/resource/${resource}/latest`,
		{
			headers: {
				authorization: `Bearer ${githubToken}`,
				"Cache-Control": "no-cache",
				"X-Account-Type": "github",
				"X-Client-Name": "homerun",
			},
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (response.status === 401 || response.status === 403) {
		throw new Error(
			"Settings Sync rejected your GitHub token. Reconnect GitHub under Git providers and try again.",
		);
	}
	if (!response.ok) {
		throw new Error(`Settings Sync answered ${response.status}.`);
	}
	return await response.text();
}

/**
 * Reads the extensions and user settings VS Code's Settings Sync stored for
 * a GitHub account, the same store VS Code itself syncs to, and checks each
 * extension against Open VSX, since a workstation start fails on one Open
 * VSX doesn't have.
 *
 * @throws When the sync store rejects the token, can't be reached, or
 * answers with something that isn't Settings Sync data.
 */
export async function fetchSyncedEditor(
	githubToken: string,
): Promise<SyncedEditor> {
	const [extensionsBody, settingsBody] = await Promise.all([
		readResource(githubToken, "extensions"),
		readResource(githubToken, "settings"),
	]);
	const ids = parseSyncedExtensions(extensionsBody);
	const found = await Promise.all(
		ids.map(async (id) => ({ id, ok: await openVsxHas(id) })),
	);
	return {
		extensions: found.filter((ext) => ext.ok).map((ext) => ext.id),
		missingExtensions: found.filter((ext) => !ext.ok).map((ext) => ext.id),
		settings: parseSyncedSettings(settingsBody),
	};
}
