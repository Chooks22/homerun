import { describe, expect, test } from "bun:test";
import { deflateSync, gzipSync } from "node:zlib";
import { internalDsn, publicDsn, sentryEnv } from "#lib/error-tracking/dsn.js";
import {
	decodeBody,
	EnvelopeError,
	isIngestPath,
	jsonPayload,
	parseEnvelope,
	sentryKeyOf,
} from "#lib/error-tracking/envelope.js";
import {
	culpritFrame,
	normalizeEvent,
	userKeyOf,
} from "#lib/error-tracking/event.js";
import { frameLinks } from "#lib/error-tracking/frame-links.js";
import {
	defaultGroupingComponents,
	groupingHash,
	normalizeMessage,
} from "#lib/error-tracking/grouping.js";
import { WindowRateLimiter } from "#lib/error-tracking/rate-limit.js";
import { sdkSnippets } from "#lib/error-tracking/snippets.js";
import {
	isCommitSha,
	providerFromHost,
	repoRelativePath,
	repoWebUrl,
	sourceFileUrl,
} from "#lib/error-tracking/source-links.js";
import { errorIssueMessage } from "#lib/services/notification-messages.js";

const encoder = new TextEncoder();
const NOW = new Date("2026-09-26T12:00:00.000Z");

function nodeEvent(overrides: Record<string, unknown> = {}) {
	return {
		environment: "production",
		event_id: "0123456789abcdef0123456789abcdef",
		exception: {
			values: [
				{
					mechanism: { handled: false, type: "onuncaughtexception" },
					stacktrace: {
						frames: [
							{
								abs_path: "/app/node_modules/express/lib/router.js",
								filename: "/app/node_modules/express/lib/router.js",
								function: "handle",
								in_app: false,
								lineno: 10,
							},
							{
								abs_path: "/app/src/users.js",
								context_line: "  return user.name;",
								filename: "/app/src/users.js",
								function: "readUser",
								in_app: true,
								lineno: 42,
								post_context: ["}"],
								pre_context: ["function readUser(user) {"],
							},
						],
					},
					type: "TypeError",
					value: "Cannot read properties of undefined (reading 'name')",
				},
			],
		},
		level: "error",
		platform: "node",
		release: "abc1234",
		timestamp: NOW.getTime() / 1000 - 5,
		...overrides,
	};
}

describe("parseEnvelope", () => {
	test("reads items with and without a length, trailing newline optional", () => {
		const event = JSON.stringify({ event_id: "a" });
		const body = encoder.encode(
			`{"event_id":"a","dsn":"https://key@host/1"}\n{"type":"event","length":${encoder.encode(event).length}}\n${event}\n{"type":"session"}\n{"started":"x"}`,
		);
		const envelope = parseEnvelope(body);
		expect(envelope.header.dsn).toBe("https://key@host/1");
		expect(envelope.items.map((item) => item.type)).toEqual([
			"event",
			"session",
		]);
		expect(jsonPayload(envelope.items[0].payload)).toEqual({ event_id: "a" });
	});

	test("a length-prefixed payload may contain newlines", () => {
		const payload = '{"a":\n1}';
		const body = encoder.encode(
			`{}\n{"type":"event","length":${payload.length}}\n${payload}\n`,
		);
		expect(jsonPayload(parseEnvelope(body).items[0].payload)).toEqual({ a: 1 });
	});

	test("skips blank lines between items", () => {
		const body = encoder.encode('{}\n\n{"type":"client_report"}\n{}\n');
		expect(parseEnvelope(body).items).toHaveLength(1);
	});

	test("rejects a bad header and a short payload", () => {
		expect(() => parseEnvelope(encoder.encode("nope\n"))).toThrow(
			EnvelopeError,
		);
		expect(() => parseEnvelope(encoder.encode("[1]\n"))).toThrow(EnvelopeError);
		expect(() =>
			parseEnvelope(encoder.encode('{}\n{"type":"event","length":50}\n{}')),
		).toThrow(EnvelopeError);
	});

	test("jsonPayload returns null for garbage", () => {
		expect(jsonPayload(encoder.encode("{"))).toBeNull();
	});
});

describe("decodeBody", () => {
	const raw = encoder.encode('{"hello":"world"}');

	test("passes identity through and inflates gzip and deflate", () => {
		expect(decodeBody(raw, null, 1000)).toBe(raw);
		expect(decodeBody(raw, "identity", 1000)).toBe(raw);
		expect(
			new TextDecoder().decode(decodeBody(gzipSync(raw), "gzip", 1000)),
		).toBe('{"hello":"world"}');
		expect(
			new TextDecoder().decode(decodeBody(deflateSync(raw), "deflate", 1000)),
		).toBe('{"hello":"world"}');
	});

	test("refuses corrupt, oversized and unknown encodings", () => {
		expect(() => decodeBody(raw, "gzip", 1000)).toThrow(EnvelopeError);
		expect(() =>
			decodeBody(gzipSync(new Uint8Array(5000)), "gzip", 1000),
		).toThrow(EnvelopeError);
		expect(() => decodeBody(raw, "br", 1000)).toThrow(EnvelopeError);
	});
});

describe("sentryKeyOf", () => {
	const url = new URL("https://homerun.test/api/1/envelope/");

	test("reads the X-Sentry-Auth header", () => {
		expect(
			sentryKeyOf({
				authHeader:
					"Sentry sentry_version=7, sentry_client=sentry.javascript.node/8.0.0, sentry_key=abc123",
				url,
			}),
		).toBe("abc123");
	});

	test("falls back to the query, then the envelope dsn", () => {
		expect(
			sentryKeyOf({
				authHeader: null,
				url: new URL("https://homerun.test/api/1/store/?sentry_key=q1"),
			}),
		).toBe("q1");
		expect(
			sentryKeyOf({
				authHeader: "Bearer nope",
				envelopeDsn: "https://dsnkey@homerun.test/1",
				url,
			}),
		).toBe("dsnkey");
		expect(
			sentryKeyOf({ authHeader: null, envelopeDsn: "::", url }),
		).toBeNull();
		expect(
			sentryKeyOf({ authHeader: "Sentry sentry_version=7", url }),
		).toBeNull();
	});
});

describe("isIngestPath", () => {
	test("matches both endpoints, with or without a base path", () => {
		expect(isIngestPath("/api/12/envelope/")).toBe(true);
		expect(isIngestPath("/homerun/api/3/store")).toBe(true);
		expect(isIngestPath("/api/v1/services")).toBe(false);
		expect(isIngestPath("/api/abc/envelope/")).toBe(false);
	});
});

describe("normalizeEvent", () => {
	test("keeps the shape and derives title and culprit", () => {
		const event = normalizeEvent(nodeEvent(), NOW);
		expect(event?.title).toBe(
			"TypeError: Cannot read properties of undefined (reading 'name')",
		);
		expect(event?.culprit).toBe("readUser (/app/src/users.js)");
		expect(event?.exceptions[0].frames[1]).toMatchObject({
			contextLine: "  return user.name;",
			inApp: true,
			lineno: 42,
			postContext: ["}"],
			preContext: ["function readUser(user) {"],
		});
		expect(event?.exceptions[0].handled).toBe(false);
		expect(event?.eventId).toBe("0123456789abcdef0123456789abcdef");
		expect(event?.timestamp).toBe(new Date(NOW.getTime() - 5000).toISOString());
	});

	test("falls back on odd input", () => {
		expect(normalizeEvent("nope", NOW)).toBeNull();
		const event = normalizeEvent(
			{
				breadcrumbs: [
					{
						category: "http",
						data: { url: "/x" },
						timestamp: "2026-09-26T11:59:00Z",
					},
				],
				contexts: { big: { blob: "x".repeat(5000) }, os: { name: "linux" } },
				event_id: "not-hex",
				level: "warn",
				logentry: { formatted: "Order 1234 failed\nsecond line" },
				request: { method: "GET", url: "https://app.test/x" },
				sdk: { name: "sentry.python", version: "2.0" },
				tags: [["route", "/x"], ["bad"]],
				timestamp: "2020-01-01T00:00:00Z",
				user: { id: 7, ip_address: "1.2.3.4" },
			},
			NOW,
		);
		expect(event?.title).toBe("Order 1234 failed");
		expect(event?.level).toBe("warning");
		expect(event?.eventId).toMatch(/^[0-9a-f]{32}$/);
		expect(event?.timestamp).toBe(NOW.toISOString());
		expect(event?.contexts).toEqual({ os: { name: "linux" } });
		expect(event?.breadcrumbs[0].message).toBe('{"url":"/x"}');
		expect(event?.tags).toEqual([["route", "/x"]]);
		expect(event?.sdk).toBe("sentry.python@2.0");
		expect(event?.request).toEqual({
			method: "GET",
			url: "https://app.test/x",
		});
		expect(event && userKeyOf(event)).toBe("7");
	});

	test("maps levels, messages and caps long stacks", () => {
		expect(
			normalizeEvent({ level: "critical", message: "boom" }, NOW)?.level,
		).toBe("fatal");
		expect(
			normalizeEvent({ level: "nope", message: { message: "m" } }, NOW),
		).toMatchObject({
			level: "error",
			title: "m",
		});
		expect(normalizeEvent({}, NOW)?.title).toBe("<unlabeled event>");
		const frames = Array.from({ length: 100 }, (_, index) => ({
			function: `f${index}`,
		}));
		const event = normalizeEvent(
			{ exception: [{ stacktrace: { frames }, type: "E" }], timestamp: "bad" },
			NOW,
		);
		expect(event?.exceptions[0].frames).toHaveLength(60);
		expect(event?.exceptions[0].frames.at(-1)?.function).toBe("f99");
		expect(event?.culprit).toBe("f99");
		expect(userKeyOf(event ?? normalizeEvent({}, NOW)!)).toBeNull();
	});

	test("culpritFrame falls back to the innermost frame", () => {
		expect(culpritFrame([])).toBeNull();
	});
});

describe("grouping", () => {
	test("ignores line numbers and library frames", () => {
		const first = normalizeEvent(nodeEvent(), NOW)!;
		const moved = nodeEvent();
		moved.exception.values[0].stacktrace.frames[1].lineno = 99;
		moved.exception.values[0].stacktrace.frames[0].function = "other";
		expect(groupingHash(normalizeEvent(moved, NOW)!)).toBe(groupingHash(first));
		expect(defaultGroupingComponents(first)).toEqual([
			"type:TypeError",
			"/app/src/users.js:readUser",
		]);
	});

	test("groups messages with numbers and ids normalized", () => {
		const one = normalizeEvent(
			{ message: "Order 12 failed for 5f2b3c4d-1111-2222-3333-444455556666" },
			NOW,
		)!;
		const two = normalizeEvent(
			{ message: "Order 99 failed for 0e2b3c4d-1111-2222-3333-444455556666" },
			NOW,
		)!;
		expect(groupingHash(one)).toBe(groupingHash(two));
		expect(normalizeMessage("at 0xdeadbeef")).toBe("at <hex>");
	});

	test("exceptions without frames group by type and value", () => {
		const event = normalizeEvent(
			{ exception: { values: [{ type: "E", value: "id 5" }] } },
			NOW,
		)!;
		expect(defaultGroupingComponents(event)).toEqual([
			"type:E",
			"value:id <n>",
		]);
	});

	test("an SDK fingerprint wins, {{ default }} expanding", () => {
		const base = normalizeEvent(nodeEvent(), NOW)!;
		const custom = normalizeEvent(
			nodeEvent({ fingerprint: ["db-down"] }),
			NOW,
		)!;
		const withDefault = normalizeEvent(
			nodeEvent({ fingerprint: ["{{ default }}", "tenant-a"] }),
			NOW,
		)!;
		expect(groupingHash(custom)).not.toBe(groupingHash(base));
		expect(groupingHash(withDefault)).not.toBe(groupingHash(base));
		expect(groupingHash(withDefault)).toHaveLength(32);
	});
});

describe("source links", () => {
	test("strips build roots and bundler prefixes", () => {
		expect(repoRelativePath("/app/src/users.js")).toBe("src/users.js");
		expect(repoRelativePath("/usr/src/app/lib/a.py")).toBe("lib/a.py");
		expect(repoRelativePath("/workspace/repo/main.go")).toBe("main.go");
		expect(repoRelativePath("webpack://my-app/./src/x.ts")).toBe("src/x.ts");
		expect(repoRelativePath("webpack:///src/x.ts?abc")).toBe("src/x.ts");
		expect(repoRelativePath("app:///dist/index.js")).toBe("dist/index.js");
		expect(repoRelativePath("file:///app/server.js")).toBe("server.js");
		expect(repoRelativePath("./handlers/a.py", "api")).toBe(
			"api/handlers/a.py",
		);
		expect(repoRelativePath("api/a.py", "./api/")).toBe("api/a.py");
	});

	test("refuses what can't be a repository path", () => {
		expect(repoRelativePath(null)).toBeNull();
		expect(repoRelativePath("https://cdn.test/app.js")).toBeNull();
		expect(repoRelativePath("/home/me/elsewhere.js")).toBeNull();
		expect(repoRelativePath("/app/node_modules/x/index.js")).toBeNull();
		expect(repoRelativePath("../outside.js")).toBeNull();
	});

	test("builds each provider's URL format", () => {
		const input = {
			commit: "abc1234",
			line: 42,
			path: "src/a b.ts",
			repoUrl: "https://host/o/r",
		};
		expect(sourceFileUrl({ ...input, provider: "github" })).toBe(
			"https://host/o/r/blob/abc1234/src/a%20b.ts#L42",
		);
		expect(sourceFileUrl({ ...input, provider: "gitlab" })).toBe(
			"https://host/o/r/-/blob/abc1234/src/a%20b.ts#L42",
		);
		expect(sourceFileUrl({ ...input, provider: "gitea" })).toBe(
			"https://host/o/r/src/commit/abc1234/src/a%20b.ts#L42",
		);
		expect(sourceFileUrl({ ...input, line: null, provider: "bitbucket" })).toBe(
			"https://host/o/r/src/abc1234/src/a%20b.ts",
		);
		expect(sourceFileUrl({ ...input, provider: "bitbucket" })).toEndWith(
			"#lines-42",
		);
		expect(
			sourceFileUrl({
				...input,
				branch: true,
				commit: "main",
				provider: "gitea",
			}),
		).toBe("https://host/o/r/src/branch/main/src/a%20b.ts#L42");
		expect(
			sourceFileUrl({
				...input,
				branch: true,
				commit: "main",
				provider: "github",
			}),
		).toBe("https://host/o/r/blob/main/src/a%20b.ts#L42");
	});

	test("reads repositories and providers from clone URLs", () => {
		expect(repoWebUrl("git@github.com:me/app.git")).toBe(
			"https://github.com/me/app",
		);
		expect(repoWebUrl("https://token@GitLab.com/g/s/app.git/")).toBe(
			"https://gitlab.com/g/s/app",
		);
		expect(repoWebUrl("not a url")).toBeNull();
		expect(repoWebUrl("https://host/")).toBeNull();
		expect(providerFromHost("github.com")).toBe("github");
		expect(providerFromHost("gitlab.example.com")).toBe("gitlab");
		expect(providerFromHost("bitbucket.org")).toBe("bitbucket");
		expect(providerFromHost("codeberg.org")).toBe("gitea");
		expect(providerFromHost("git.example.com")).toBeNull();
		expect(isCommitSha("abc1234")).toBe(true);
		expect(isCommitSha("v1.2.3")).toBe(false);
		expect(isCommitSha(null)).toBe(false);
	});

	test("frameLinks links only mappable in-app frames", () => {
		const event = normalizeEvent(nodeEvent(), NOW)!;
		expect(frameLinks(event, null)).toEqual({});
		expect(
			frameLinks(event, {
				buildContext: null,
				commit: "abc1234",
				provider: "github",
				repoUrl: "https://github.com/me/app",
			}),
		).toEqual({
			"0:1": "https://github.com/me/app/blob/abc1234/src/users.js#L42",
		});
	});
});

describe("WindowRateLimiter", () => {
	test("allows the limit per window, then says when to retry", () => {
		const limiter = new WindowRateLimiter(2, 60_000);
		expect(limiter.hit("a", 0)).toBeNull();
		expect(limiter.hit("a", 1000)).toBeNull();
		expect(limiter.hit("a", 30_000)).toBe(30);
		expect(limiter.hit("b", 30_000)).toBeNull();
		expect(limiter.hit("a", 60_000)).toBeNull();
	});
});

describe("DSNs and injected env", () => {
	const project = { projectId: 4, publicKey: "k" };

	test("builds public and internal DSNs, keeping a base path", () => {
		expect(publicDsn("https://dash.test", project)).toBe(
			"https://k@dash.test/4",
		);
		expect(publicDsn("https://dash.test/homerun/", project)).toBe(
			"https://k@dash.test/homerun/4",
		);
		expect(publicDsn("nope", project)).toBeNull();
		expect(
			internalDsn("homerun-auth", 3000, "https://dash.test/h", project),
		).toBe("http://k@homerun-auth:3000/h/4");
		expect(internalDsn("homerun-auth", 3000, null, project)).toBe(
			"http://k@homerun-auth:3000/4",
		);
		expect(internalDsn("h", 1, "::", project)).toBe("http://k@h:1/4");
	});

	test("leaves the service's own variables alone", () => {
		expect(
			sentryEnv({
				dsn: "d",
				environment: "preview",
				release: null,
				userEnv: {},
			}),
		).toEqual({
			env: [
				["SENTRY_DSN", "d"],
				["SENTRY_ENVIRONMENT", "preview"],
			],
			releaseFromBuild: true,
		});
		expect(
			sentryEnv({
				dsn: "d",
				environment: "production",
				release: "nginx:1",
				userEnv: { SENTRY_DSN: "mine" },
			}),
		).toEqual({
			env: [
				["SENTRY_ENVIRONMENT", "production"],
				["SENTRY_RELEASE", "nginx:1"],
			],
			releaseFromBuild: false,
		});
		expect(
			sentryEnv({
				dsn: "d",
				environment: "p",
				release: null,
				userEnv: { SENTRY_RELEASE: "x" },
			}).releaseFromBuild,
		).toBe(false);
	});

	test("snippets rely on the env when it's injected", () => {
		const injected = sdkSnippets("https://k@p/1", "http://k@i/1", true);
		expect(injected.map((snippet) => snippet.id)).toEqual([
			"node",
			"python",
			"go",
			"browser",
		]);
		expect(injected[0].code).toContain("Sentry.init({})");
		expect(injected[3].code).toContain("https://k@p/1");
		expect(sdkSnippets("p", "http://k@i/1", false)[1].code).toContain(
			'dsn="http://k@i/1"',
		);
	});
});

describe("errorIssueMessage", () => {
	test("links to the issue and names a regression", () => {
		const message = errorIssueMessage(
			{
				issue: {
					count: 3,
					culprit: "readUser (src/users.js)",
					id: "i1",
					lastEnvironment: "production",
					lastRelease: "abc1234",
					level: "error",
					title: "TypeError: boom",
				},
				origin: "https://dash.test",
				regressed: true,
				service: { id: "s1", name: "api" },
			},
			NOW.toISOString(),
		);
		expect(message.event).toBe("error.issue.regressed");
		expect(message.title).toBe("api: error regressed");
		expect(message.link).toBe(
			"https://dash.test/services/s1/observability/errors/i1",
		);
		expect(message.fields.map((field) => field.name)).toEqual([
			"Level",
			"Events",
			"Culprit",
			"Environment",
			"Release",
		]);
		const plain = errorIssueMessage(
			{
				issue: {
					count: 1,
					culprit: null,
					id: "i",
					lastEnvironment: null,
					lastRelease: null,
					level: "error",
					title: "t",
				},
				origin: null,
				regressed: false,
				service: { id: "s", name: "n" },
			},
			NOW.toISOString(),
		);
		expect(plain.event).toBe("error.issue.new");
		expect(plain.link).toBeNull();
		expect(plain.fields).toHaveLength(2);
	});
});
