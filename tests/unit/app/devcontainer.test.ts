import { describe, expect, test } from "bun:test";
import {
	appendDevcontainerForm,
	applyDevcontainer,
	type DevcontainerFormValues,
	hasApplicable,
	mergeDevcontainerForm,
	parseDevcontainer,
	repoPathOf,
	stripJsonc,
} from "#lib/devcontainer.js";

const SAMPLE = `{
	// A comment, and a URL that isn't one: "https://example.com"
	"name": "Node",
	"image": "mcr.microsoft.com/devcontainers/typescript-node:22",
	/* block
	   comment */
	"features": { "ghcr.io/devcontainers/features/go:1": {} },
	"containerEnv": { "NODE_ENV": "development", "HOME_REF": "\${localEnv:HOME}" },
	"remoteEnv": { "API_URL": "https://api.example.com//v1" },
	"customizations": {
		"vscode": {
			"extensions": ["dbaeumer.vscode-eslint", "Esbenp.Prettier-VSCode", "not an id",],
			"settings": { "editor.tabSize": 2 },
		},
	},
	"postCreateCommand": "npm ci",
}`;

describe("devcontainer", () => {
	test("JSONC comments and trailing commas go, strings stay", () => {
		expect(
			JSON.parse(stripJsonc('{"a": "x // y", // c\n "b": [1,],}')),
		).toEqual({ a: "x // y", b: [1] });
	});

	test("a config yields its extensions, settings and plain env", () => {
		const config = parseDevcontainer(SAMPLE, ".devcontainer/devcontainer.json");
		expect(config).toEqual({
			env: { API_URL: "https://api.example.com//v1", NODE_ENV: "development" },
			extensions: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"],
			image: "mcr.microsoft.com/devcontainers/typescript-node:22",
			name: "Node",
			path: ".devcontainer/devcontainer.json",
			settings: { "editor.tabSize": 2 },
			unsupported: ["features", "image", "postCreateCommand"],
		});
		expect(config && hasApplicable(config)).toBe(true);
	});

	test("legacy top-level extensions and settings count too", () => {
		const config = parseDevcontainer(
			'{"extensions": ["a.b"], "settings": {"x": 1}}',
			".devcontainer.json",
		);
		expect(config?.extensions).toEqual(["a.b"]);
		expect(config?.settings).toEqual({ x: 1 });
	});

	test("anything that isn't a JSON object is no config", () => {
		expect(parseDevcontainer("[]", "x")).toBeNull();
		expect(parseDevcontainer("{", "x")).toBeNull();
	});

	test("applying adds extensions and lets the config win on the same keys", () => {
		const config = parseDevcontainer(SAMPLE, "p");
		if (!config) {
			throw new Error("no config");
		}
		expect(
			applyDevcontainer(
				{
					editorSettings: { "editor.tabSize": 4, "files.eol": "\n" },
					env: { NODE_ENV: "production", KEEP: "1" },
					extensions: ["dbaeumer.vscode-eslint", "mine.ext"],
				},
				config,
			),
		).toEqual({
			editorSettings: { "editor.tabSize": 2, "files.eol": "\n" },
			env: {
				API_URL: "https://api.example.com//v1",
				KEEP: "1",
				NODE_ENV: "development",
			},
			extensions: [
				"dbaeumer.vscode-eslint",
				"mine.ext",
				"esbenp.prettier-vscode",
			],
		});
	});

	test("a clone URL's repository path", () => {
		expect(repoPathOf("https://github.com/acme/app.git")).toBe("acme/app");
		expect(repoPathOf("https://gitlab.com/group/sub/app")).toBe(
			"group/sub/app",
		);
		expect(repoPathOf("https://github.com/")).toBeNull();
		expect(repoPathOf("nope")).toBeNull();
	});

	test("merging into the forms keeps what's typed there and fills blanks from the fallback", () => {
		const config = parseDevcontainer(SAMPLE, "p");
		if (!config) {
			throw new Error("no config");
		}
		const typed = new FormData();
		typed.append("extensions", "mine.ext");
		typed.set("editorSettings", '{"files.eol":"\\n"}');
		typed.set("env", "KEEP=1");
		typed.set("image", "");
		typed.set("port", "3000");
		typed.set("homePath", "/home/workspace");
		typed.set("cpuLimit", "2");
		typed.set("memoryLimitMb", "");
		const fallback: DevcontainerFormValues & { id: string } = {
			cpuLimit: null,
			editorSettings: {},
			env: {},
			extensions: [],
			homePath: "/home/coder",
			id: "ws1",
			image: "codercom/code-server:latest",
			memoryLimitMb: 512,
			port: 8080,
		};
		const merged = mergeDevcontainerForm(typed, fallback, config);
		expect(merged).toEqual({
			cpuLimit: 2,
			editorSettings: { "editor.tabSize": 2, "files.eol": "\n" },
			env: {
				API_URL: "https://api.example.com//v1",
				KEEP: "1",
				NODE_ENV: "development",
			},
			extensions: [
				"mine.ext",
				"dbaeumer.vscode-eslint",
				"esbenp.prettier-vscode",
			],
			homePath: "/home/workspace",
			id: "ws1",
			image: "codercom/code-server:latest",
			memoryLimitMb: null,
			port: 3000,
		});

		const posted = new FormData();
		appendDevcontainerForm(posted, merged);
		expect(posted.getAll("extensions")).toEqual(merged.extensions);
		expect(JSON.parse(String(posted.get("editorSettings")))).toEqual(
			merged.editorSettings,
		);
		expect(String(posted.get("env")).split("\n").sort()).toEqual([
			"API_URL=https://api.example.com//v1",
			"KEEP=1",
			"NODE_ENV=development",
		]);
		expect(posted.get("port")).toBe("3000");
		expect(posted.get("memoryLimitMb")).toBe("");
	});
});
