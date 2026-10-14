import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { config } = await import("../../../src/lib/config");
const { Logger } = await import("../../../src/lib/logger");
const { RedirectDTO } = await import("../../../src/lib/dto/redirect-dto");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { REDIRECTS_FILE } = await import("../../../src/lib/redirects");
const dnsModule = await import("../../../src/lib/services/dns.service");
const { RedirectService, redirectHost } = await import(
	"../../../src/lib/services/redirect.service"
);
const { redirectSchema } = await import(
	"../../../src/lib/server/validation/redirect"
);

type DnsResult = Awaited<ReturnType<typeof dnsModule.syncDns>>[number];

function rule(overrides: Record<string, unknown> = {}) {
	const row = {
		destination: "https://new.example.com/",
		enabled: true,
		id: "r1",
		keepPath: true,
		permanent: true,
		source: "old.example.com",
		...overrides,
	};
	return { toJSON: () => row };
}

const originalTraefik = { ...config.traefik };
const originalPangolin = config.pangolinEnabled;
let directory = "";
let rules: ReturnType<typeof rule>[] = [];
let listError: unknown = null;
const servicesByHost = new Map<string, string>();
const synced: string[][] = [];
const deleted: string[][] = [];
let syncResults: DnsResult[] = [];
let syncError: unknown = null;
const logs: { level: string; message: string }[] = [];
const spies: { mockRestore: () => void }[] = [];

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "homerun-redirects-"));
	config.traefik.dynamicConfigDir = directory;
	config.traefik.certResolver = "letsencrypt";
	config.traefik.entrypoint = "websecure";
	config.traefik.instanceCertNames = [];
	config.pangolinEnabled = false;
	rules = [];
	listError = null;
	servicesByHost.clear();
	synced.length = 0;
	deleted.length = 0;
	syncResults = [];
	syncError = null;
	logs.length = 0;
	stub(RedirectDTO, "list", async () => {
		if (listError) {
			throw listError;
		}
		return rules;
	});
	stub(
		ServiceDTO,
		"domainTaken",
		async ([host]: string[]) => servicesByHost.get(host) ?? null,
	);
	spies.push(
		spyOn(dnsModule, "syncDns").mockImplementation(async (hosts: string[]) => {
			if (syncError) {
				throw syncError;
			}
			synced.push(hosts);
			return syncResults;
		}),
		spyOn(dnsModule, "deleteDns").mockImplementation(
			async (hosts: string[]) => {
				deleted.push(hosts);
				return [];
			},
		),
	);
	for (const level of ["info", "warn", "error"]) {
		stub(Logger.prototype, level, (message: string) => {
			logs.push({ level, message });
		});
	}
});

afterEach(async () => {
	restoreStubs();
	for (const spy of spies.splice(0)) {
		spy.mockRestore();
	}
	Object.assign(config.traefik, originalTraefik);
	config.pangolinEnabled = originalPangolin;
	await rm(directory, { force: true, recursive: true });
});

describe("redirectHost", () => {
	test("is the host of a valid source, null otherwise", () => {
		expect(redirectHost("Example.com/blog")).toBe("example.com");
		expect(redirectHost("not a host")).toBeNull();
	});
});

describe("RedirectService.sync", () => {
	test("publishes the enabled redirects to Traefik with their cert resolver", async () => {
		rules = [
			rule(),
			rule({ enabled: false, id: "r2", source: "off.example.com" }),
		];
		await RedirectService.sync();
		const published = JSON.parse(
			await readFile(join(directory, REDIRECTS_FILE), "utf8"),
		);
		expect(Object.keys(published.http.routers)).toEqual([
			"homerun-redirect-r1",
		]);
		expect(published.http.routers["homerun-redirect-r1"]).toMatchObject({
			entryPoints: ["websecure"],
			tls: { certResolver: "letsencrypt" },
		});
		expect(logs).toContainEqual({
			level: "info",
			message: "Redirects published to Traefik",
		});
	});

	test("behind Pangolin a redirect gets plain TLS", async () => {
		config.pangolinEnabled = true;
		rules = [rule()];
		await RedirectService.sync();
		const published = JSON.parse(
			await readFile(join(directory, REDIRECTS_FILE), "utf8"),
		);
		expect(published.http.routers["homerun-redirect-r1"].tls).toEqual({});
	});

	test("removes the file once no redirect is enabled", async () => {
		const path = join(directory, REDIRECTS_FILE);
		await writeFile(path, "stale");
		rules = [rule({ enabled: false })];
		await RedirectService.sync();
		await expect(stat(path)).rejects.toThrow();
	});

	test("without a dynamic config directory nothing is written, DNS still syncs", async () => {
		config.traefik.dynamicConfigDir = undefined;
		rules = [rule()];
		await RedirectService.sync();
		expect(logs).toContainEqual({
			level: "warn",
			message:
				"Traefik's dynamic config directory isn't set, so redirects aren't published",
		});
		expect(synced).toEqual([["old.example.com"]]);
	});

	test("a directory that can't be written is logged, not thrown", async () => {
		const file = join(directory, "not-a-directory");
		await writeFile(file, "x");
		config.traefik.dynamicConfigDir = file;
		rules = [rule()];
		await RedirectService.sync();
		expect(logs.map((entry) => entry.message)).toContain(
			"Couldn't publish the redirects",
		);
	});

	test("a failed listing stops before touching Traefik or DNS", async () => {
		listError = new Error("db down");
		await RedirectService.sync(["old.example.com"]);
		expect(logs).toEqual([
			{ level: "error", message: "Couldn't load the redirects" },
		]);
		expect(synced).toEqual([]);
		expect(deleted).toEqual([]);
	});

	test("syncs each enabled host once and deletes the dropped ones, leaving service hosts alone", async () => {
		rules = [
			rule(),
			rule({ id: "r2", source: "old.example.com/blog" }),
			rule({ id: "r3", source: "app.example.com" }),
			rule({ enabled: false, id: "r4", source: "gone.example.com" }),
		];
		servicesByHost.set("app.example.com", "web");
		servicesByHost.set("shared.example.com", "api");
		syncResults = [
			{ detail: "old.example.com: created", ok: true, provider: "Cloudflare" },
			{ detail: "old.example.com: refused", ok: false, provider: "Pangolin" },
		];
		await RedirectService.sync([
			"old.example.com",
			"gone.example.com",
			"gone.example.com",
			"shared.example.com",
		]);
		expect(synced).toEqual([["old.example.com"]]);
		expect(deleted).toEqual([["gone.example.com"]]);
		expect(logs).toContainEqual({
			level: "info",
			message: "Redirect DNS (Cloudflare): old.example.com: created",
		});
		expect(logs).toContainEqual({
			level: "warn",
			message: "Redirect DNS sync failed (Pangolin): old.example.com: refused",
		});
	});

	test("a DNS failure is logged, not thrown", async () => {
		rules = [rule()];
		syncError = new Error("provider down");
		await RedirectService.sync();
		expect(logs).toContainEqual({
			level: "error",
			message: "Couldn't sync the redirects' DNS",
		});
	});
});

describe("redirectSchema", () => {
	test("normalizes the source and destination and reads the checkboxes", () => {
		expect(
			redirectSchema.parse({
				destination: "https://new.example.com",
				enabled: "on",
				keepPath: true,
				permanent: undefined,
				source: " Old.Example.com/Blog/ ",
			}),
		).toEqual({
			destination: "https://new.example.com/",
			enabled: true,
			keepPath: true,
			permanent: false,
			source: "old.example.com/blog",
		});
	});

	test("rejects a source that isn't a host and a destination that isn't a URL", () => {
		const result = redirectSchema.safeParse({
			destination: "javascript:alert(1)",
			source: "https://old.example.com",
		});
		expect(result.success).toBe(false);
		expect(
			result.error?.issues.map((issue) => [issue.path[0], issue.message]),
		).toEqual([
			[
				"source",
				'Source is a hostname with an optional path prefix, e.g. "old.example.com" or "example.com/blog".',
			],
			["destination", "Destination must be a full http(s) URL."],
		]);
	});
});
