import { describe, expect, test } from "bun:test";
import {
	createServiceSchema,
	parseEnvVars,
	parseSecretEnvKeys,
	updateRuntimeSchema,
} from "../../../src/lib/server/validation/service";

describe("updateRuntimeSchema", () => {
	test("trims the run-as user, stores blank as null and rejects a bad one", () => {
		expect(updateRuntimeSchema.parse({ runAsUser: " 1000 " }).runAsUser).toBe(
			"1000",
		);
		expect(updateRuntimeSchema.parse({ runAsUser: "" }).runAsUser).toBe(null);
		expect(updateRuntimeSchema.parse({}).runAsUser).toBe(null);
		expect(updateRuntimeSchema.safeParse({ runAsUser: "1000:" }).success).toBe(
			false,
		);
	});

	test("parses capabilities and labels, and flags bad ones", () => {
		const parsed = updateRuntimeSchema.parse({
			capAdd: "net_admin, SYS_TIME",
			labels: "team=a\n\nx.y = b",
		});
		expect(parsed.capAdd).toEqual(["NET_ADMIN", "SYS_TIME"]);
		expect(parsed.labels).toEqual({ team: "a", "x.y": "b" });
		const bad = updateRuntimeSchema.safeParse({
			capAdd: "net-admin",
			labels: "=nokey",
		});
		expect(bad.error?.issues.map((i) => i.path[0]).sort()).toEqual([
			"capAdd",
			"labels",
		]);
	});
});

describe("createServiceSchema", () => {
	const base = { containerPort: "80", name: "Web", slug: "web" };

	test("needs an image for an image service and a git URL for a git one", () => {
		expect(
			createServiceSchema.safeParse({ ...base, image: "nginx" }).success,
		).toBe(true);
		expect(createServiceSchema.safeParse(base).error?.issues[0]?.path).toEqual([
			"image",
		]);
		expect(
			createServiceSchema.safeParse({ ...base, buildSource: "git" }).error
				?.issues[0]?.path,
		).toEqual(["gitUrl"]);
	});
});

describe("parseEnvVars", () => {
	test("zips keys and values, dropping blank keys", () => {
		const form = new FormData();
		for (const [key, value] of [
			[" A ", "1"],
			["", "ignored"],
			["B", "2"],
		]) {
			form.append("envKey", key as string);
			form.append("envValue", value as string);
		}
		expect(parseEnvVars(form)).toEqual({ A: "1", B: "2" });
	});

	test("an untouched secret keeps its stored value, a typed one replaces it", () => {
		const form = new FormData();
		for (const [key, value, keep] of [
			["API_TOKEN", "", "TOKEN"],
			["DB_PASSWORD", "new-one", "DB_PASSWORD"],
			["GONE", "", "MISSING"],
			["TZ", "UTC", ""],
		]) {
			form.append("envKey", key as string);
			form.append("envValue", value as string);
			form.append("envKeep", keep as string);
		}
		form.append("envSecret", "API_TOKEN");
		form.append("envSecret", "API_TOKEN");
		form.append("envSecret", "DROPPED");
		const stored = { DB_PASSWORD: "old", TOKEN: "t0k3n" };
		const envVars = parseEnvVars(form, stored);
		expect(envVars).toEqual({
			API_TOKEN: "t0k3n",
			DB_PASSWORD: "new-one",
			GONE: "",
			TZ: "UTC",
		});
		expect(parseSecretEnvKeys(form, envVars)).toEqual(["API_TOKEN"]);
	});
});
