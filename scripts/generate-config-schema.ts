import { z } from "zod";
import { yamlConfigSchema } from "../src/lib/config";
import { builtinTemplateFileSchema } from "../src/lib/server/db/builtin-templates";
import { manifestJsonSchema } from "../src/lib/server/manifest";

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

const outputs = [
	[
		"homerun.schema.json",
		z.toJSONSchema(yamlConfigSchema, { target: "draft-7" }),
	],
	[
		"templates/schema.json",
		z.toJSONSchema(builtinTemplateFileSchema, { target: "draft-7" }),
	],
	["manifest.schema.json", manifestJsonSchema()],
] as const;

for (const [path, schema] of outputs) {
	await Bun.write(path, JSON.stringify(sortKeysDeep(schema), null, "\t"));
}

Bun.spawnSync(
	["bunx", "biome", "check", "--write", ...outputs.map(([path]) => path)],
	{ stderr: "inherit", stdout: "inherit" },
);

console.log(`Wrote ${outputs.map(([path]) => path).join(", ")}`);
