import { describe, expect, mock, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const {
	SCRIPT_RUNTIME_SPECS,
	SCRIPT_RUNTIMES,
	describeCronJobTarget,
	invalidFilePath,
	parseScriptRuntime,
	scriptPath,
} = await import("../../../src/lib/cron-job-script");
const { parseCronJobForm, parseCronJobInput } = await import(
	"../../../src/lib/server/cron-job-form"
);

const base = { enabled: "on", name: "renovate", schedule: "0 3 * * *" };

function form(fields: Record<string, string>, files: [string, string][]) {
	const data = new FormData();
	for (const [name, value] of Object.entries(fields)) {
		data.set(name, value);
	}
	for (const [path, content] of files) {
		data.append("filePath", path);
		data.append("fileContent", content);
	}
	return data;
}

describe("invalidFilePath", () => {
	test("accepts an absolute file path", () => {
		expect(invalidFilePath("/tmp/config.js")).toBeNull();
	});

	test("refuses relative, directory and traversal paths", () => {
		expect(invalidFilePath("config.js")).toContain("absolute");
		expect(invalidFilePath("/tmp/")).toContain("directory");
		expect(invalidFilePath("/tmp/../etc/passwd")).toContain("..");
		expect(invalidFilePath("/tmp//x")).toContain("empty");
	});
});

describe("script runtimes", () => {
	test("parses known runtimes only", () => {
		expect(parseScriptRuntime("python")).toBe("python");
		expect(parseScriptRuntime("ruby")).toBeNull();
	});

	test("puts the source under /homerun with the runtime's extension", () => {
		expect(scriptPath("python")).toBe("/homerun/main.py");
		expect(scriptPath("bun")).toBe("/homerun/main.ts");
	});

	test("runs each runtime's interpreter on the source file", () => {
		const argv = Object.fromEntries(
			SCRIPT_RUNTIMES.map((runtime) => [
				runtime,
				SCRIPT_RUNTIME_SPECS[runtime].run(scriptPath(runtime)),
			]),
		);
		expect(argv).toEqual({
			bun: ["bun", "run", "/homerun/main.ts"],
			deno: ["deno", "run", "--allow-all", "/homerun/main.ts"],
			node: ["node", "/homerun/main.mjs"],
			python: ["python", "-u", "/homerun/main.py"],
			shell: ["sh", "/homerun/main.sh"],
		});
	});

	test("describes each kind", () => {
		const job = { command: null, image: null, runtime: null, tag: null };
		expect(
			describeCronJobTarget({
				...job,
				image: "renovate/renovate",
				kind: "image",
			}),
		).toBe("renovate/renovate:latest");
		expect(
			describeCronJobTarget({ ...job, kind: "script", runtime: "python" }),
		).toBe("Python script");
		expect(
			describeCronJobTarget({ ...job, command: "df -h", kind: "exec" }),
		).toBe("df -h");
	});
});

describe("parseCronJobForm", () => {
	test("keeps a script job's source and runtime and drops the image", () => {
		const result = parseCronJobForm(
			form(
				{
					...base,
					image: "ignored",
					kind: "script",
					runtime: "python",
					source: "print('hi')\n",
				},
				[],
			),
			{ hostAccess: false },
		);
		expect(result).toMatchObject({
			parsed: {
				command: null,
				image: null,
				kind: "script",
				runtime: "python",
				source: "print('hi')\n",
			},
		});
	});

	test("requires a script job's source", () => {
		const result = parseCronJobForm(
			form({ ...base, kind: "script", runtime: "node", source: " " }, []),
			{ hostAccess: false },
		);
		expect(result).toEqual({ error: "Source code is required." });
	});

	test("requires what each kind runs", () => {
		const options = { hostAccess: true };
		expect(
			parseCronJobForm(form({ ...base, kind: "image" }, []), options),
		).toEqual({ error: "Image is required." });
		expect(
			parseCronJobForm(
				form({ ...base, kind: "script", source: "x" }, []),
				options,
			),
		).toEqual({ error: "Pick a runtime." });
		expect(
			parseCronJobForm(form({ ...base, kind: "exec" }, []), options),
		).toEqual({ error: "Command is required." });
	});

	test("refuses a host command without host access or a bad schedule", () => {
		expect(
			parseCronJobForm(form({ ...base, command: "df", kind: "exec" }, []), {
				hostAccess: false,
			}),
		).toEqual({ error: "A host command job needs write access to System." });
		expect(
			parseCronJobForm(
				form({ ...base, image: "alpine", kind: "image", schedule: "nope" }, []),
				{ hostAccess: false },
			),
		).toMatchObject({ error: expect.stringContaining("Invalid schedule") });
	});

	test("refuses too many files and a NUL byte", () => {
		const fields = { ...base, image: "alpine", kind: "image" };
		const many = Array.from({ length: 21 }, (_, i) => ({
			content: "",
			path: `/tmp/${i}`,
		}));
		expect(parseCronJobInput(fields, {}, many, { hostAccess: false })).toEqual({
			error: "At most 20 config files.",
		});
		expect(
			parseCronJobInput(fields, {}, [{ content: "a\0b", path: "/tmp/x" }], {
				hostAccess: false,
			}),
		).toMatchObject({ error: expect.stringContaining("NUL") });
	});

	test("pairs config files, drops blank paths and normalises line endings", () => {
		const result = parseCronJobForm(
			form({ ...base, image: "renovate/renovate", kind: "image" }, [
				[" /tmp/config.js ", "a\r\nb"],
				["", "dropped"],
			]),
			{ hostAccess: false },
		);
		expect(result).toMatchObject({
			parsed: { files: [{ content: "a\nb", path: "/tmp/config.js" }] },
		});
	});

	test("refuses a bad or duplicated file path", () => {
		const fields = { ...base, image: "alpine", kind: "image" };
		expect(
			parseCronJobForm(form(fields, [["etc/x", ""]]), { hostAccess: false }),
		).toEqual({ error: '"etc/x" isn\'t an absolute path.' });
		expect(
			parseCronJobForm(
				form(fields, [
					["/a", ""],
					["/a", ""],
				]),
				{ hostAccess: false },
			),
		).toEqual({ error: '"/a" is listed twice.' });
	});

	test("refuses an oversized file", () => {
		const result = parseCronJobInput(
			{ ...base, image: "alpine", kind: "image" },
			{},
			[{ content: "x".repeat(64_001), path: "/tmp/big" }],
			{ hostAccess: false },
		);
		expect(result).toEqual({ error: '"/tmp/big" is over 64 kB.' });
	});

	test("drops config files from a host command", () => {
		const result = parseCronJobInput(
			{ ...base, command: "df -h", kind: "exec" },
			{},
			[{ content: "x", path: "/tmp/x" }],
			{ hostAccess: true },
		);
		expect(result).toMatchObject({ parsed: { files: [], kind: "exec" } });
	});
});
