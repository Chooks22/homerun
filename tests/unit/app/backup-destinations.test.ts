import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { DESTINATION_PRESETS, DESTINATION_TYPES, describeDestination } =
	await import("../../../src/lib/backup-destinations");
const { parseDestinationForm } = await import(
	"../../../src/lib/server/backup-destination-form"
);
const { listRemoteBackups, rcloneRemote, splitHostPort, testRemote } =
	await import("../../../src/lib/services/backup/rclone");
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);

const FAKE_KEY = ["-----BEGIN OPENSSH", "PRIVATE KEY-----\nabc\n-----END"].join(
	" ",
);

const restorers: { mockRestore: () => void }[] = [];

afterEach(() => {
	for (const spy of restorers.splice(0)) {
		spy.mockRestore();
	}
});

function form(fields: Record<string, string>): FormData {
	const data = new FormData();
	for (const [name, value] of Object.entries(fields)) {
		data.set(name, value);
	}
	return data;
}

function listing(exitCode: number, stdout: string, stderr = "") {
	const spy = spyOn(DockerService, "runOneOff").mockResolvedValue({
		exitCode,
		stderr: Buffer.from(stderr),
		stdout: Buffer.from(stdout),
		timedOut: false,
	});
	restorers.push(spy);
	return spy;
}

const REMOTE = rcloneRemote({
	host: "nas.local:2222",
	path: "backups",
	secret: "hunter2",
	type: "sftp",
	username: "bob",
});

describe("parseDestinationForm", () => {
	test("an S3 form without a type stays an S3 destination", () => {
		expect(
			parseDestinationForm(
				form({
					accessKeyId: "key",
					bucket: "homerun",
					endpoint: "https://s3.example.com",
					name: "B2",
					region: "eu-central-1",
					secretAccessKey: "secret",
				}),
			),
		).toEqual({
			parsed: {
				accessKeyId: "key",
				bucket: "homerun",
				endpoint: "https://s3.example.com",
				name: "B2",
				region: "eu-central-1",
				secretAccessKey: "secret",
				type: "s3",
			},
		});
	});

	test("an SFTP private key wins over the password and the path loses its trailing slash", () => {
		const result = parseDestinationForm(
			form({
				accessKeyId: "u1",
				bucket: "/volume1/backups/",
				endpoint: "box.example.com:23",
				name: "Box",
				privateKey: FAKE_KEY,
				secretAccessKey: "ignored",
				type: "sftp",
			}),
		);
		expect("parsed" in result && result.parsed).toMatchObject({
			bucket: "/volume1/backups",
			region: "",
			secretAccessKey: FAKE_KEY,
			type: "sftp",
		});
	});

	test.each([
		[{ type: "ftp" }, "Unknown destination type."],
		[
			{ accessKeyId: "u", endpoint: "nas", name: "n", type: "sftp" },
			"Give a password or a private key.",
		],
		[
			{
				accessKeyId: "u",
				endpoint: "smb://nas",
				name: "n",
				secretAccessKey: "p",
				type: "smb",
			},
			"Host is a hostname or an address, with an optional :port.",
		],
		[
			{
				accessKeyId: "u",
				endpoint: "nas",
				name: "n",
				secretAccessKey: "p",
				type: "smb",
			},
			"Give the share's name, then an optional path under it.",
		],
		[
			{
				accessKeyId: "u",
				endpoint: "box.example.com",
				name: "n",
				secretAccessKey: "p",
				type: "webdav",
			},
			"URL must start with http:// or https://.",
		],
	])("rejects %j", (fields, error) => {
		expect(parseDestinationForm(form(fields))).toEqual({ error });
	});
});

describe("parseDestinationForm on an edit", () => {
	test("a blank secret is allowed and stays blank, so the stored one is kept", () => {
		const result = parseDestinationForm(
			form({
				accessKeyId: "u1",
				bucket: "share/homerun",
				endpoint: "nas.local",
				name: "NAS",
				type: "smb",
			}),
			{ keepSecret: true },
		);
		expect("parsed" in result && result.parsed.secretAccessKey).toBe("");
	});

	test("the other fields are still required", () => {
		expect(
			parseDestinationForm(
				form({ accessKeyId: "u1", endpoint: "nas.local", type: "smb" }),
				{ keepSecret: true },
			),
		).toEqual({ error: "Name, host and username are required." });
	});
});

describe("testRemote", () => {
	test("writes a test file under the destination's path, then deletes that same file", async () => {
		const spy = listing(0, "");
		await testRemote(REMOTE);
		const commands = spy.mock.calls.map((call) => call[0].cmd ?? []);
		expect(commands.map((cmd) => cmd[0])).toEqual(["touch", "deletefile"]);
		expect(commands[0]?.[1]).toStartWith("dest:backups/.homerun-test-");
		expect(commands[1]?.[1]).toBe(commands[0]?.[1]);
	});

	test("a failed write carries rclone's own error and deletes nothing", async () => {
		const spy = listing(1, "", "ssh: unable to authenticate");
		await expect(testRemote(REMOTE)).rejects.toThrow(
			"Couldn't write to sftp://bob@nas.local:2222/backups: ssh: unable to authenticate",
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("rcloneRemote", () => {
	test("an SFTP password goes through the obscuring wrapper, the port is split off the host", () => {
		expect(REMOTE.env).toEqual({
			HOMERUN_PASS: "hunter2",
			RCLONE_CONFIG_DEST_HOST: "nas.local",
			RCLONE_CONFIG_DEST_PORT: "2222",
			RCLONE_CONFIG_DEST_SHELL_TYPE: "none",
			RCLONE_CONFIG_DEST_TYPE: "sftp",
			RCLONE_CONFIG_DEST_USER: "bob",
			RCLONE_LOG_LEVEL: "ERROR",
		});
		expect(REMOTE.entrypoint.slice(0, 2)).toEqual(["sh", "-c"]);
		expect(REMOTE.label).toBe("sftp://bob@nas.local:2222/backups");
	});

	test("an SFTP private key is passed on one line instead of a password", () => {
		const { env } = rcloneRemote({
			host: "nas.local",
			path: "",
			secret: `${FAKE_KEY}\n`,
			type: "sftp",
			username: "bob",
		});
		expect(env.RCLONE_CONFIG_DEST_KEY_PEM).toBe(
			FAKE_KEY.replaceAll("\n", "\\n"),
		);
		expect(env.HOMERUN_PASS).toBeUndefined();
		expect(env.RCLONE_CONFIG_DEST_PORT).toBeUndefined();
	});

	test("WebDAV takes a URL and SMB a bare host", () => {
		const webdav = rcloneRemote({
			host: "https://box.example.com",
			path: "",
			secret: "p",
			type: "webdav",
			username: "u1",
		});
		expect(webdav.env.RCLONE_CONFIG_DEST_URL).toBe("https://box.example.com");
		expect(webdav.env.RCLONE_CONFIG_DEST_VENDOR).toBe("other");
		expect(webdav.label).toBe("https://box.example.com");
		const smb = rcloneRemote({
			host: "nas.local",
			path: "share/homerun",
			secret: "p",
			type: "smb",
			username: "u1",
		});
		expect(smb.env.RCLONE_CONFIG_DEST_HOST).toBe("nas.local");
		expect(smb.env.RCLONE_CONFIG_DEST_SHELL_TYPE).toBeUndefined();
	});

	test("splitHostPort unwraps a bracketed IPv6 address", () => {
		expect(splitHostPort("[fd00::1]:23")).toEqual({
			host: "fd00::1",
			port: "23",
		});
		expect(splitHostPort("nas.local")).toEqual({
			host: "nas.local",
			port: null,
		});
	});
});

describe("listRemoteBackups", () => {
	test("lists the prefix's directory and keeps this volume's archives, newest first", async () => {
		const spy = listing(
			0,
			JSON.stringify([
				{ ModTime: "2026-01-01T00:00:00Z", Name: "db-1.tar.gz", Size: 10 },
				{ ModTime: "2026-01-02T00:00:00Z", Name: "db-2.tar.gz", Size: 20 },
				{ Name: "db-3.tar.gz.partial", Size: 5 },
				{ Name: "other-1.tar.gz", Size: 7 },
			]),
		);
		expect(await listRemoteBackups(REMOTE, "pfx/db-")).toEqual([
			{
				key: "pfx/db-2.tar.gz",
				label: "pfx/db-2.tar.gz",
				lastModified: "2026-01-02T00:00:00Z",
				sizeBytes: 20,
			},
			{
				key: "pfx/db-1.tar.gz",
				label: "pfx/db-1.tar.gz",
				lastModified: "2026-01-01T00:00:00Z",
				sizeBytes: 10,
			},
		]);
		expect(spy.mock.calls[0]?.[0].cmd?.at(-1)).toBe("dest:backups/pfx");
	});

	test("a directory that doesn't exist yet is an empty list", async () => {
		listing(3, "[\n", "directory not found");
		expect(await listRemoteBackups(REMOTE, "db-")).toEqual([]);
	});

	test("any other failure carries rclone's own error", async () => {
		listing(1, "", "ssh: handshake failed");
		await expect(listRemoteBackups(REMOTE, "db-")).rejects.toThrow(
			"Couldn't list the backups on sftp://bob@nas.local:2222/backups: ssh: handshake failed",
		);
	});
});

describe("describeDestination", () => {
	test("an S3 row keeps its endpoint, bucket and region", () => {
		expect(
			describeDestination({
				accessKeyId: "key",
				bucket: "homerun",
				endpoint: "https://s3.example.com",
				region: "eu-central-1",
				type: "s3",
			}),
		).toBe("https://s3.example.com · homerun · eu-central-1");
	});
});

describe("DESTINATION_PRESETS", () => {
	test("the Hetzner Storage Box preset is SFTP on port 23 of a host named after the account", () => {
		const preset = DESTINATION_PRESETS.find(
			(candidate) => candidate.id === "hetzner-storage-box",
		);
		expect(preset?.type).toBe("sftp");
		expect(preset?.endpointFor?.("u123456-sub1")).toBe(
			"u123456-sub1.your-storagebox.de:23",
		);
		expect(preset?.endpointFor?.("")).toBe("");
	});

	test("every preset has its own id and a known type", () => {
		const ids = DESTINATION_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const preset of DESTINATION_PRESETS) {
			expect(DESTINATION_TYPES).toContain(preset.type);
		}
	});
});
