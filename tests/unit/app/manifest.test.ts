import { describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { manifestFields, manifestJsonSchema, manifestPaths, parseManifest } =
	await import("../../../src/lib/server/manifest");

describe("parseManifest", () => {
	test("reads JSON and drops $schema", () => {
		expect(
			parseManifest(
				'{"$schema": "x", "containerPort": 3000, "authProviders": ["email-otp"], "authAllowedEmails": ["*@example.com"]}',
				".homerun.json",
			),
		).toEqual({
			manifest: {
				authAllowedEmails: ["*@example.com"],
				authProviders: ["email-otp"],
				containerPort: 3000,
			},
		});
	});

	test("reads YAML by file name", () => {
		expect(
			parseManifest("containerPort: 8080\nenvVars:\n  A: b\n", ".homerun.yml"),
		).toEqual({ manifest: { containerPort: 8080, envVars: { A: "b" } } });
	});

	test("an empty file is an empty manifest", () => {
		expect(parseManifest("", ".homerun.yaml")).toEqual({ manifest: {} });
	});

	test("names every problem with its key, unknown keys included", () => {
		const parsed = parseManifest(
			'{"containerPort": "80", "port": 80}',
			".homerun.json",
		);
		expect("errors" in parsed && parsed.errors).toEqual([
			"containerPort: Invalid input: expected number, received string",
			'Unrecognized key: "port"',
		]);
	});

	test("refuses host access, labels and registry secrets", () => {
		for (const key of [
			"privileged",
			"capAdd",
			"devices",
			"envFiles",
			"labels",
			"networkMode",
			"publishedPorts",
			"registryPassword",
			"slug",
		]) {
			expect(
				"errors" in parseManifest(`{"${key}": null}`, ".homerun.json"),
			).toBe(true);
		}
	});

	test("reports broken syntax", () => {
		const parsed = parseManifest("{nope", ".homerun.json");
		expect("errors" in parsed && parsed.errors[0]).toContain(
			"isn't valid JSON",
		);
	});
});

describe("manifestFields", () => {
	const manifest = {
		authRequired: false,
		containerPort: 80,
		domains: ["app.example.com"],
		gitBuildMethod: "railpack" as const,
		image: "nginx",
		previewsEnabled: true,
	};

	test("a service takes everything", () => {
		expect(manifestFields(manifest, "full", false)).toEqual({
			fields: manifest,
			ignored: [],
		});
	});

	test("a git service ignores image keys", () => {
		expect(manifestFields(manifest, "full", true).ignored).toEqual(["image"]);
	});

	test("a preview takes only how it's built and run", () => {
		expect(manifestFields(manifest, "build-runtime", true)).toEqual({
			fields: { containerPort: 80, gitBuildMethod: "railpack" },
			ignored: ["authRequired", "domains", "image", "previewsEnabled"],
		});
	});
});

describe("manifestPaths", () => {
	test("looks next to the build context first", () => {
		expect(manifestPaths("./apps/web/")).toEqual([
			"apps/web/.homerun.json",
			"apps/web/.homerun.yaml",
			"apps/web/.homerun.yml",
			".homerun.json",
			".homerun.yaml",
			".homerun.yml",
		]);
		expect(manifestPaths(null)).toEqual([
			".homerun.json",
			".homerun.yaml",
			".homerun.yml",
		]);
		expect(manifestPaths(".")).toHaveLength(3);
	});
});

describe("manifestJsonSchema", () => {
	test("describes every key and forbids unknown ones", () => {
		const schema = manifestJsonSchema() as {
			additionalProperties: boolean;
			properties: Record<string, { description?: string }>;
		};
		expect(schema.additionalProperties).toBe(false);
		const undescribed = Object.entries(schema.properties)
			.filter(([, property]) => !property.description)
			.map(([key]) => key);
		expect(undescribed).toEqual([]);
	});
});
