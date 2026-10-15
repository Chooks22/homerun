import { describe, expect, test } from "bun:test";
import {
	envEditorRows,
	envRowKeep,
	mergeEnvRows,
	type ParsedEnvVar,
	parseDotEnv,
	plainEnvRow,
	toggleEnvRowSecret,
} from "../../../src/lib/env-parse";

describe("parseDotEnv", () => {
	test("parses KEY=value lines, CRLF included", () => {
		expect(parseDotEnv("A=1\r\nB=two words\n")).toEqual([
			{ key: "A", value: "1" },
			{ key: "B", value: "two words" },
		]);
	});

	test("skips blanks, comments, lines without = and invalid keys", () => {
		expect(
			parseDotEnv("\n# comment\nNOEQUALS\n1BAD=x\nBAD-KEY=y\n=z\nOK=1"),
		).toEqual([{ key: "OK", value: "1" }]);
	});

	test("strips an export prefix and surrounding whitespace", () => {
		expect(parseDotEnv("  export   TOKEN = abc  ")).toEqual([
			{ key: "TOKEN", value: "abc" },
		]);
	});

	test("unquotes one layer of matching quotes only", () => {
		expect(
			parseDotEnv(
				[
					'A="double"',
					"B='single'",
					"C=\"mismatched'",
					'D=""',
					'E="',
					"F='\"nested\"'",
				].join("\n"),
			),
		).toEqual([
			{ key: "A", value: "double" },
			{ key: "B", value: "single" },
			{ key: "C", value: "\"mismatched'" },
			{ key: "D", value: "" },
			{ key: "E", value: '"' },
			{ key: "F", value: '"nested"' },
		]);
	});

	test("keeps everything after the first = in the value", () => {
		expect(parseDotEnv("URL=postgres://u:p@h/db?a=b")).toEqual([
			{ key: "URL", value: "postgres://u:p@h/db?a=b" },
		]);
	});
});

describe("mergeEnvRows", () => {
	interface Row extends ParsedEnvVar {
		id: number;
	}
	let next = 100;
	const makeRow = (row: ParsedEnvVar): Row => ({ ...row, id: next++ });

	test("overwrites existing keys in place and appends new ones", () => {
		const existing: Row[] = [
			{ id: 1, key: "A", value: "old" },
			{ id: 2, key: "B", value: "keep" },
		];
		const merged = mergeEnvRows(
			existing,
			[
				{ key: "A", value: "new" },
				{ key: "C", value: "added" },
			],
			makeRow,
		);
		expect(merged.map(({ key, value }) => [key, value])).toEqual([
			["A", "new"],
			["B", "keep"],
			["C", "added"],
		]);
		expect(merged[0].id).toBe(1);
	});

	test("drops the blank placeholder row once real rows exist", () => {
		const merged = mergeEnvRows(
			[{ id: 1, key: "", value: "" }],
			[{ key: "A", value: "1" }],
			makeRow,
		);
		expect(merged.map((r) => r.key)).toEqual(["A"]);
	});

	test("always leaves at least one blank row", () => {
		const merged = mergeEnvRows([{ id: 1, key: "", value: "" }], [], makeRow);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ key: "", value: "" });
	});
});

describe("the env editor's rows", () => {
	const envVars = { API_TOKEN: "t0k3n", TZ: "UTC" };

	test("a secret starts with no value, keeping the stored one under its name", () => {
		expect(envEditorRows(envVars, ["API_TOKEN"])).toEqual([
			{
				build: false,
				keep: "API_TOKEN",
				key: "API_TOKEN",
				secret: true,
				value: "",
			},
			{ build: false, keep: null, key: "TZ", secret: false, value: "UTC" },
		]);
		expect(envEditorRows({}, [])).toEqual([plainEnvRow()]);
	});

	test("a var named in the build keys is flagged build-time, secret or not", () => {
		expect(
			envEditorRows(envVars, ["API_TOKEN"], ["API_TOKEN", "TZ"]).map(
				(row) => row.build,
			),
		).toEqual([true, true]);
		expect(envEditorRows(envVars, [], ["TZ"]).map((row) => row.build)).toEqual([
			false,
			true,
		]);
	});

	test("a row only keeps the stored value while it has no new one", () => {
		const [secret] = envEditorRows(envVars, ["API_TOKEN"]);
		if (!secret) {
			throw new Error("no row");
		}
		expect(envRowKeep(secret)).toBe("API_TOKEN");
		expect(envRowKeep({ ...secret, value: "typed" })).toBe("");
		expect(envRowKeep(plainEnvRow({ key: "A", value: "" }))).toBe("");
	});

	test("unmarking an untouched secret shows its stored value again", () => {
		const [secret, plain] = envEditorRows(envVars, ["API_TOKEN"]);
		if (!secret || !plain) {
			throw new Error("no rows");
		}
		toggleEnvRowSecret(secret, envVars);
		expect(secret).toEqual({
			build: false,
			keep: null,
			key: "API_TOKEN",
			secret: false,
			value: "t0k3n",
		});
		toggleEnvRowSecret(plain, envVars);
		expect(plain).toEqual({
			build: false,
			keep: null,
			key: "TZ",
			secret: true,
			value: "UTC",
		});
	});
});
