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
const { parseCronJobForm, parseCronJobInput, parseCronJobSection } =
	await import("../../../src/lib/server/cron-job-form");

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
		expect(
			parseCronJobInput(
				fields,
				{ envVars: {}, files: many, mounts: [] },
				{ hostAccess: false },
			),
		).toEqual({
			error: "At most 20 config files.",
		});
		expect(
			parseCronJobInput(
				fields,
				{
					envVars: {},
					files: [{ content: "a\0b", path: "/tmp/x" }],
					mounts: [],
				},
				{
					hostAccess: false,
				},
			),
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
			{
				envVars: {},
				files: [{ content: "x".repeat(64_001), path: "/tmp/big" }],
				mounts: [],
			},
			{ hostAccess: false },
		);
		expect(result).toEqual({ error: '"/tmp/big" is over 64 kB.' });
	});

	test("drops config files from a host command", () => {
		const result = parseCronJobInput(
			{ ...base, command: "df -h", kind: "exec" },
			{ envVars: {}, files: [{ content: "x", path: "/tmp/x" }], mounts: [] },
			{ hostAccess: true },
		);
		expect(result).toMatchObject({ parsed: { files: [], kind: "exec" } });
	});
});

describe("container options", () => {
	const fields = { ...base, image: "renovate/renovate", kind: "image" };

	test("keeps a user, the socket, volumes and file modes", () => {
		const data = form({ ...fields, dockerSocket: "on", runAsUser: "12021:0" }, [
			["/tmp/config.js", "{}"],
		]);
		data.append("fileMode", "600");
		data.append("mountVolumeId", "v1");
		data.append("mountPath", " /tmp/renovate ");
		data.append("mountReadOnly", "0");
		data.append("mountVolumeId", "");
		data.append("mountPath", "");
		data.append("mountReadOnly", "0");
		expect(parseCronJobForm(data, { hostAccess: true })).toMatchObject({
			parsed: {
				dockerSocket: true,
				files: [{ content: "{}", mode: "600", path: "/tmp/config.js" }],
				mounts: [
					{ containerPath: "/tmp/renovate", readOnly: false, volumeId: "v1" },
				],
				runAsUser: "12021:0",
			},
		});
	});

	test("refuses the socket without host access, a bad user, mode or mount", () => {
		expect(
			parseCronJobInput(
				{ ...fields, dockerSocket: true },
				{ envVars: {}, files: [], mounts: [] },
				{
					hostAccess: false,
				},
			),
		).toEqual({
			error: "Giving a job the Docker socket needs write access to System.",
		});
		expect(
			parseCronJobInput(
				{ ...fields, runAsUser: "root; rm" },
				{ envVars: {}, files: [], mounts: [] },
				{
					hostAccess: false,
				},
			),
		).toEqual({ error: "Use uid, uid:gid, name or name:group." });
		expect(
			parseCronJobInput(
				fields,
				{
					envVars: {},
					files: [{ content: "", mode: "999", path: "/a" }],
					mounts: [],
				},
				{
					hostAccess: false,
				},
			),
		).toMatchObject({ error: expect.stringContaining("octal") });
		expect(
			parseCronJobInput(
				fields,
				{
					envVars: {},
					files: [],
					mounts: [{ containerPath: "/cache", readOnly: false, volumeId: "" }],
				},
				{ hostAccess: false },
			),
		).toEqual({ error: 'Pick a volume for "/cache".' });
	});

	test("a host command keeps none of them", () => {
		expect(
			parseCronJobInput(
				{
					...base,
					command: "df",
					dockerSocket: true,
					kind: "exec",
					runAsUser: "1000",
				},
				{
					envVars: {},
					files: [],
					mounts: [
						{ containerPath: "/cache", readOnly: false, volumeId: "v1" },
					],
				},
				{ hostAccess: true },
			),
		).toMatchObject({
			parsed: { dockerSocket: false, mounts: [], runAsUser: null },
		});
	});
});

describe("parseCronJobSection", () => {
	const stored = {
		command: null,
		createdAt: new Date(),
		description: "old",
		dockerSocket: false,
		enabled: true,
		envVars: { TOKEN: "x" },
		files: [{ content: "{}", path: "/tmp/config.js" }],
		id: "j1",
		image: "renovate/renovate",
		kind: "image" as const,
		lastRunAt: null,
		mounts: [{ containerPath: "/cache", readOnly: false, volumeId: "v1" }],
		name: "renovate",
		registryPasswordEnc: null,
		registryUrl: null,
		registryUsername: null,
		remoteHostId: null,
		runAsUser: "12021",
		runtime: null,
		schedule: "0 3 * * *",
		source: null,
		tag: "latest",
		timeoutSeconds: 900,
		updatedAt: new Date(),
		userId: "u1",
	};

	test("settings change only the settings, an unchecked box turns it off", () => {
		const data = new FormData();
		data.set("name", "renovate nightly");
		data.set("schedule", "0 4 * * *");
		expect(
			parseCronJobSection(stored, data, "settings", { hostAccess: false }),
		).toMatchObject({
			parsed: {
				description: null,
				enabled: false,
				envVars: { TOKEN: "x" },
				image: "renovate/renovate",
				mounts: stored.mounts,
				name: "renovate nightly",
				runAsUser: "12021",
				schedule: "0 4 * * *",
			},
		});
	});

	test("configuration replaces the container side and keeps the settings", () => {
		const data = new FormData();
		data.set("kind", "image");
		data.set("image", "alpine");
		expect(
			parseCronJobSection(stored, data, "configuration", { hostAccess: false }),
		).toMatchObject({
			parsed: {
				enabled: true,
				envVars: {},
				files: [],
				image: "alpine",
				mounts: [],
				name: "renovate",
				runAsUser: null,
			},
		});
	});
});
