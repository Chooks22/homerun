import { afterEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { RegistryService } = await import(
	"../../../src/lib/services/registry.service"
);
const { requiredPermission } = await import("../../../src/lib/permissions");
const repositoriesRoute = await import(
	"../../../src/routes/api/v1/registry/repositories/+server"
);
const tagsRoute = await import(
	"../../../src/routes/api/v1/registry/repositories/[...repository]/tags/+server"
);

afterEach(() => {
	restoreStubs();
});

const signedIn = { permissions: {}, user: { id: "u1" } };

/** A route event for `search` and `repository`, signed in unless `locals` says otherwise. */
function event(
	options: { locals?: unknown; repository?: string; search?: string } = {},
): never {
	return {
		locals: options.locals ?? signedIn,
		params: { repository: options.repository ?? "team/app" },
		url: new URL(`http://localhost/x${options.search ?? ""}`),
	} as never;
}

const appRepository = {
	repository: "team/app",
	tags: [{ digest: "sha256:abc", tag: "1.0" }],
	usedBy: [{ id: "svc-1", name: "App" }],
};

describe("the registry's repositories route", () => {
	test("lists one page of repositories with the paging headers", async () => {
		const queries: unknown[] = [];
		stub(RegistryService, "catalogPage", async (query: unknown) => {
			queries.push(query);
			return { items: [appRepository], page: 2, perPage: 10, total: 11 };
		});
		const response = await repositoriesRoute.GET(
			event({ search: "?page=2&perPage=10&q=team" }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([appRepository]);
		expect(response.headers.get("x-total-count")).toBe("11");
		expect(queries[0]).toMatchObject({ page: 2, perPage: 10, q: "team" });
	});

	test("answers 503 with the reason when the registry isn't answering", async () => {
		stub(RegistryService, "catalogPage", async () => {
			throw new Error("connection refused");
		});
		const response = await repositoriesRoute.GET(event());
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "The registry isn't answering: connection refused",
		});
	});

	test("refuses a caller who isn't signed in", async () => {
		const response = await repositoriesRoute.GET(
			event({ locals: { user: null } }),
		);
		expect(response.status).toBe(401);
	});
});

describe("a registry repository's tags route", () => {
	test("lists the tags with their digests", async () => {
		const asked: string[] = [];
		stub(RegistryService, "repository", async (name: string) => {
			asked.push(name);
			return appRepository;
		});
		const response = await tagsRoute.GET(event());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(appRepository.tags);
		expect(asked).toEqual(["team/app"]);
	});

	test("answers 404 for a repository with no tag", async () => {
		stub(RegistryService, "repository", async () => null);
		expect((await tagsRoute.GET(event())).status).toBe(404);
	});

	test("refuses a name that isn't a repository before asking the registry", async () => {
		let asked = false;
		stub(RegistryService, "repository", async () => {
			asked = true;
			return null;
		});
		const response = await tagsRoute.GET(event({ repository: "../_catalog" }));
		expect(response.status).toBe(400);
		expect(asked).toBe(false);
	});

	test("answers 503 when the registry isn't answering, 401 signed out", async () => {
		stub(RegistryService, "repository", async () => {
			throw "down";
		});
		const response = await tagsRoute.GET(event());
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "The registry isn't answering: down",
		});
		expect((await tagsRoute.GET(event({ locals: {} }))).status).toBe(401);
	});

	test("both routes belong to the Docker Registry area", () => {
		expect(requiredPermission("GET", "/api/v1/registry/repositories")).toEqual({
			area: "registry",
			level: "read",
		});
		expect(
			requiredPermission(
				"GET",
				"/api/v1/registry/repositories/[...repository]/tags",
			),
		).toEqual({ area: "registry", level: "read" });
	});
});
