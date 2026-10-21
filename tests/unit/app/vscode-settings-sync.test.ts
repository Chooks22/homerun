import { afterEach, describe, expect, test } from "bun:test";
import { openVsxHas, searchOpenVsx } from "../../../src/lib/services/open-vsx";
import {
	fetchSyncedEditor,
	parseSyncedExtensions,
	parseSyncedSettings,
} from "../../../src/lib/services/vscode-settings-sync";

function body(version: number, entries: unknown[]): string {
	return JSON.stringify({
		content: JSON.stringify(entries),
		machineId: "m",
		version,
	});
}

describe("parseSyncedExtensions", () => {
	test("keeps enabled, user-installed extensions, lowercased and deduplicated", () => {
		const ids = parseSyncedExtensions(
			body(6, [
				{ identifier: { id: "Esbenp.Prettier-VSCode" }, installed: true },
				{ identifier: { id: "esbenp.prettier-vscode" }, installed: true },
				{ identifier: { id: "golang.go" }, installed: true, disabled: true },
				{ identifier: { id: "vscode.git" }, disabled: true },
				{ identifier: { id: "ms-python.python" } },
			]),
		);
		expect(ids).toEqual(["esbenp.prettier-vscode"]);
	});

	test("keeps every enabled entry from pre-v3 data, which has no installed flag", () => {
		const ids = parseSyncedExtensions(
			body(2, [
				{ identifier: { id: "golang.go" } },
				{ disabled: true, identifier: { id: "rust-lang.rust-analyzer" } },
			]),
		);
		expect(ids).toEqual(["golang.go"]);
	});

	test("an empty body means nothing was synced", () => {
		expect(parseSyncedExtensions("")).toEqual([]);
	});

	test("throws on something that isn't sync data", () => {
		expect(() => parseSyncedExtensions('{"nope":true}')).toThrow();
	});
});

describe("parseSyncedSettings", () => {
	test("unwraps the settings file and strips its JSONC", () => {
		const settings = parseSyncedSettings(
			JSON.stringify({
				content: JSON.stringify({
					settings:
						'{\n  // theme\n  "workbench.colorTheme": "Dark+",\n  "http.proxy": "http://x",\n}',
				}),
				version: 1,
			}),
		);
		expect(settings).toEqual({
			"http.proxy": "http://x",
			"workbench.colorTheme": "Dark+",
		});
	});

	test("reads legacy content that is the file itself", () => {
		expect(
			parseSyncedSettings(
				JSON.stringify({ content: '{"editor.tabSize": 2}', version: 1 }),
			),
		).toEqual({ "editor.tabSize": 2 });
	});

	test("nothing synced, or an empty file, is null", () => {
		expect(parseSyncedSettings("")).toBeNull();
		expect(
			parseSyncedSettings(
				JSON.stringify({
					content: JSON.stringify({ settings: "{}" }),
					version: 1,
				}),
			),
		).toBeNull();
	});
});

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): string[] {
	const seen: string[] = [];
	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		seen.push(String(input));
		return await handler(String(input), init);
	}) as unknown as typeof fetch;
	return seen;
}

describe("fetchSyncedEditor", () => {
	test("reads both resources with the GitHub token and splits extensions by Open VSX", async () => {
		const headers: Record<string, string>[] = [];
		stubFetch((url, init) => {
			if (url.includes("/resource/extensions/")) {
				headers.push(init.headers as Record<string, string>);
				return new Response(
					body(6, [
						{ identifier: { id: "golang.go" }, installed: true },
						{ identifier: { id: "ms-python.vscode-pylance" }, installed: true },
					]),
				);
			}
			if (url.includes("/resource/settings/")) {
				return new Response(
					JSON.stringify({
						content: JSON.stringify({ settings: '{"editor.tabSize": 4}' }),
						version: 1,
					}),
				);
			}
			return new Response(null, {
				status: url.includes("vscode-pylance") ? 404 : 200,
			});
		});
		const synced = await fetchSyncedEditor("tok");
		expect(synced).toEqual({
			extensions: ["golang.go"],
			missingExtensions: ["ms-python.vscode-pylance"],
			settings: { "editor.tabSize": 4 },
		});
		expect(headers[0]?.authorization).toBe("Bearer tok");
		expect(headers[0]?.["X-Account-Type"]).toBe("github");
	});

	test("a rejected token says to reconnect GitHub", async () => {
		stubFetch(() => new Response("Failed to verify token", { status: 401 }));
		await expect(fetchSyncedEditor("tok")).rejects.toThrow(/Reconnect GitHub/);
	});

	test("any other error status is reported", async () => {
		stubFetch(() => new Response("", { status: 500 }));
		await expect(fetchSyncedEditor("tok")).rejects.toThrow(/answered 500/);
	});
});

describe("openVsxHas", () => {
	test("is false only for a 404", async () => {
		const seen = stubFetch(
			(url) =>
				new Response(null, { status: url.endsWith("/nope/nope") ? 404 : 200 }),
		);
		expect(await openVsxHas("golang.go")).toBe(true);
		expect(await openVsxHas("nope.nope")).toBe(false);
		expect(seen[0]).toBe("https://open-vsx.org/api/golang/go");
	});

	test("an unreachable registry counts as published", async () => {
		stubFetch(() => {
			throw new Error("offline");
		});
		expect(await openVsxHas("golang.go")).toBe(true);
	});
});

describe("searchOpenVsx", () => {
	test("maps search hits to picker entries", async () => {
		stubFetch(() =>
			Response.json({
				extensions: [
					{
						name: "Go",
						namespace: "golang",
						downloadCount: 5,
						version: "1.0.0",
					},
				],
			}),
		);
		expect(await searchOpenVsx("go")).toEqual([
			{
				description: "",
				displayName: "Go",
				downloads: 5,
				icon: null,
				id: "golang.go",
				version: "1.0.0",
			},
		]);
	});

	test("throws on an error status", async () => {
		stubFetch(() => new Response("", { status: 503 }));
		await expect(searchOpenVsx("go")).rejects.toThrow(/503/);
	});
});
