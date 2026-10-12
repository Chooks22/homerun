import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { db } = await import("../../../src/lib/server/db/lib");
const schema = await import("../../../src/lib/server/db/schema");
const { DockerService } = await import(
	"../../../src/lib/services/docker.service"
);
const { Logger } = await import("../../../src/lib/logger");
const { UserService } = await import("../../../src/lib/services/user.service");
const { WorkstationService } = await import(
	"../../../src/lib/services/workstation.service"
);

interface Call {
	args: unknown[];
	method: string;
}

const dialect = new PgDialect();
let chains: Call[][] = [];
let respond: (calls: Call[]) => unknown = () => [];

function chain(first: Call) {
	const calls: Call[] = [first];
	chains.push(calls);
	const proxy: object = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "then") {
					return (
						resolve: (value: unknown) => unknown,
						reject: (err: unknown) => unknown,
					) => Promise.resolve(respond(calls)).then(resolve, reject);
				}
				return (...args: unknown[]) => {
					calls.push({ args, method: String(prop) });
					return proxy;
				};
			},
		},
	);
	return proxy;
}

function arg(calls: Call[], method: string): unknown {
	return calls.find((call) => call.method === method)?.args[0];
}

function rendered(calls: Call[]) {
	const where = arg(calls, "where") as SQL | undefined;
	return where ? dialect.sqlToQuery(where) : null;
}

const docker = { containers: [] as string[], networks: [] as string[] };
let workstationsRemovedFor: string[] = [];

beforeEach(() => {
	chains = [];
	respond = () => [];
	docker.containers = [];
	docker.networks = [];
	workstationsRemovedFor = [];
	stub(WorkstationService, "removeAllFor", async (userId: string) => {
		workstationsRemovedFor.push(userId);
	});
	for (const method of ["delete", "select", "update"]) {
		stub(db, method, (...args: unknown[]) => chain({ args, method }));
	}
	stub(Logger.prototype, "info", () => undefined);
	stub(DockerService, "removeContainer", async (id: string) => {
		if (id === "broken") {
			throw new Error("daemon down");
		}
		docker.containers.push(id);
	});
	stub(DockerService, "removeSwarmService", async (id: string) => {
		if (id === "sw-bad") {
			throw new Error("no manager");
		}
		docker.containers.push(`swarm:${id}`);
	});
	stub(DockerService, "removeStackNetwork", async (id: string) => {
		if (id === "bad-stack") {
			throw new Error("in use");
		}
		docker.networks.push(id);
	});
});

afterEach(restoreStubs);

describe("UserService.cleanupUserResources", () => {
	const reassignedTables = [
		schema.service,
		schema.stack,
		schema.deployment,
		schema.job,
		schema.storageVolume,
		schema.s3Destination,
		schema.buildCacheRegistry,
		schema.redirect,
		schema.remoteHost,
		schema.cronJob,
		schema.statusPage,
		schema.oauthClient,
	];

	test("hands every shared resource over to the acting admin without looking up a successor", async () => {
		await UserService.cleanupUserResources("gone", "admin-1");

		expect(chains.some((calls) => calls[0]?.method === "select")).toBe(false);
		const updates = chains.filter((calls) => calls[0]?.method === "update");
		expect(updates).toHaveLength(14);
		for (const table of reassignedTables) {
			const calls = updates.find((c) => c[0]?.args[0] === table);
			expect(calls).toBeDefined();
			expect(arg(calls ?? [], "set")).toEqual({ userId: "admin-1" });
			expect(rendered(calls ?? [])?.params).toEqual(["gone"]);
		}
		const template = updates.find((c) => c[0]?.args[0] === schema.template);
		expect(arg(template ?? [], "set")).toEqual({ ownerId: "admin-1" });
		const invite = updates.find((c) => c[0]?.args[0] === schema.invitation);
		expect(arg(invite ?? [], "set")).toEqual({ invitedByUserId: "admin-1" });
		expect(docker.containers).toEqual([]);
		expect(workstationsRemovedFor).toEqual(["gone"]);
	});

	test("ignores an acting user deleting their own account and picks the oldest other admin", async () => {
		respond = (calls) =>
			calls[0]?.method === "select" ? [{ id: "oldest-admin" }] : [];

		await UserService.cleanupUserResources("self", "self");

		const lookup = chains.find((calls) => calls[0]?.method === "select");
		expect(arg(lookup ?? [], "from")).toBe(schema.user);
		expect(rendered(lookup ?? [])?.params).toEqual(["self"]);
		expect(arg(lookup ?? [], "limit")).toBe(1);
		const updates = chains.filter((calls) => calls[0]?.method === "update");
		expect(updates).toHaveLength(14);
		expect(arg(updates[0] ?? [], "set")).toEqual({ userId: "oldest-admin" });
	});

	test("the last account removes its containers, swarm services and stack networks instead", async () => {
		respond = (calls) => {
			const table = arg(calls, "from");
			if (table === schema.user) {
				return [];
			}
			if (table === schema.service) {
				return [
					{ containerId: null, swarmServiceId: "sw-1" },
					{ containerId: "ignored", swarmServiceId: "sw-bad" },
					{ containerId: "c-1", swarmServiceId: null },
					{ containerId: "broken", swarmServiceId: null },
					{ containerId: null, swarmServiceId: null },
				];
			}
			return [{ id: "stack-1" }, { id: "bad-stack" }];
		};

		await UserService.cleanupUserResources("last");

		expect(docker.containers.sort((a, b) => a.localeCompare(b))).toEqual([
			"c-1",
			"swarm:sw-1",
		]);
		expect(docker.networks).toEqual(["stack-1"]);
		expect(chains.some((calls) => calls[0]?.method === "update")).toBe(false);
	});
});

describe("UserService reads", () => {
	test("listUsers returns rows newest first", async () => {
		const rows = [{ id: "b" }, { id: "a" }];
		respond = () => rows;

		expect(await UserService.listUsers()).toBe(rows as never);
		const [calls] = chains;
		expect(arg(calls ?? [], "from")).toBe(schema.user);
		expect(calls?.some((call) => call.method === "orderBy")).toBe(true);
	});

	test("listUsersPaged applies the search and role filters to both the page and the total", async () => {
		respond = (calls) =>
			calls[0]?.args[0] ? [{ total: 7 }] : [{ id: "u1" }, { id: "u2" }];

		const result = await UserService.listUsersPaged({
			active: true,
			filters: { role: ["admin", "user"] },
			limit: 2,
			offset: 4,
			page: 3,
			perPage: 2,
			q: "ann",
			sort: null,
		});

		expect(result).toEqual({
			items: [{ id: "u1" }, { id: "u2" }] as never,
			page: 3,
			perPage: 2,
			total: 7,
		});
		const [page, total] = chains;
		expect(arg(page ?? [], "limit")).toBe(2);
		expect(arg(page ?? [], "offset")).toBe(4);
		for (const calls of [page, total]) {
			expect(rendered(calls ?? [])?.params).toEqual([
				"%ann%",
				"%ann%",
				"admin",
				"user",
			]);
		}
	});

	test("listUsersPaged with no search or filters is unfiltered and totals 0 when empty", async () => {
		respond = () => [];

		const result = await UserService.listUsersPaged({
			active: false,
			filters: { role: [] },
			limit: 25,
			offset: 0,
			page: 1,
			perPage: 25,
			q: "",
			sort: null,
		});

		expect(result.total).toBe(0);
		expect(result.items).toEqual([]);
		for (const calls of chains) {
			expect(arg(calls, "where")).toBeUndefined();
		}
	});

	test("searchUsers matches name or email and caps the result", async () => {
		respond = () => [{ id: "u1" }];

		expect(await UserService.searchUsers("bob", 5)).toEqual([
			{ id: "u1" },
		] as never);
		const [calls] = chains;
		expect(rendered(calls ?? [])?.params).toEqual(["%bob%", "%bob%"]);
		expect(arg(calls ?? [], "limit")).toBe(5);
	});

	test("firstAdminId returns the oldest admin, or null when there is none", async () => {
		respond = () => [{ id: "first" }];
		expect(await UserService.firstAdminId()).toBe("first");
		expect(rendered(chains[0] ?? [])?.params).toEqual(["admin"]);

		respond = () => [];
		expect(await UserService.firstAdminId()).toBeNull();
	});

	test("countAdmins returns the admin count, or 0 without a row", async () => {
		respond = () => [{ total: 3 }];
		expect(await UserService.countAdmins()).toBe(3);

		respond = () => [];
		expect(await UserService.countAdmins()).toBe(0);
	});
});

describe("UserService writes", () => {
	test("setRole stores the role and a custom role's permissions", async () => {
		await UserService.setRole("u1", "custom", { services: "read" });
		const [calls] = chains;
		expect(calls?.[0]?.method).toBe("update");
		expect(arg(calls ?? [], "set")).toEqual({
			permissions: { services: "read" },
			role: "custom",
		});
		expect(rendered(calls ?? [])?.params).toEqual(["u1"]);
	});

	test("setPermissions replaces only the permissions", async () => {
		await UserService.setPermissions("u1", { stacks: "write" });
		expect(arg(chains[0] ?? [], "set")).toEqual({
			permissions: { stacks: "write" },
		});
	});

	test("setEmail changes the email and marks it verified", async () => {
		await UserService.setEmail("u1", "new@example.com");
		expect(arg(chains[0] ?? [], "set")).toEqual({
			email: "new@example.com",
			emailVerified: true,
		});
	});

	test("deleteUser deletes the row by id", async () => {
		await UserService.deleteUser("u1");
		const [calls] = chains;
		expect(calls?.[0]?.method).toBe("delete");
		expect(rendered(calls ?? [])?.params).toEqual(["u1"]);
	});
});
