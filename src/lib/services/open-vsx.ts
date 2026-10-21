import { z } from "zod";

const OPEN_VSX_URL = "https://open-vsx.org";

/** One extension as the workstation extension picker lists it. */
export interface EditorExtension {
	description: string;
	displayName: string;
	downloads: number;
	icon: string | null;
	id: string;
	version: string;
}

const searchResponseSchema = z.object({
	extensions: z
		.array(
			z.object({
				description: z.string().nullish(),
				displayName: z.string().nullish(),
				downloadCount: z.number().nullish(),
				files: z.object({ icon: z.string().nullish() }).partial().nullish(),
				name: z.string(),
				namespace: z.string(),
				version: z.string().nullish(),
			}),
		)
		.default([]),
});

/**
 * Whether Open VSX publishes `id` (`publisher.name`). An unreachable registry
 * counts as yes, so a network blip doesn't drop an extension the install
 * would have found.
 */
export async function openVsxHas(id: string): Promise<boolean> {
	const dot = id.indexOf(".");
	const url = new URL(
		`/api/${encodeURIComponent(id.slice(0, dot))}/${encodeURIComponent(id.slice(dot + 1))}`,
		OPEN_VSX_URL,
	);
	try {
		const response = await fetch(url, {
			method: "HEAD",
			signal: AbortSignal.timeout(10_000),
		});
		return response.status !== 404;
	} catch {
		return true;
	}
}

/**
 * Searches Open VSX, the registry code-server installs extensions from, most
 * relevant first.
 *
 * @throws When Open VSX can't be reached or answers with an error.
 */
export async function searchOpenVsx(
	query: string,
	size = 20,
): Promise<EditorExtension[]> {
	const url = new URL("/api/-/search", OPEN_VSX_URL);
	url.searchParams.set("query", query);
	url.searchParams.set("size", String(size));
	url.searchParams.set("sortBy", "relevance");
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) {
		throw new Error(`Open VSX answered ${response.status}.`);
	}
	const body = searchResponseSchema.parse(await response.json());
	return body.extensions.map((ext) => ({
		description: ext.description ?? "",
		displayName: ext.displayName || ext.name,
		downloads: ext.downloadCount ?? 0,
		icon: ext.files?.icon ?? null,
		id: `${ext.namespace}.${ext.name}`.toLowerCase(),
		version: ext.version ?? "",
	}));
}
