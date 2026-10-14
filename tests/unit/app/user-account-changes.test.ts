import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { UserService } = await import("../../../src/lib/services/user.service");

type Target = Parameters<typeof UserService.updateAccount>[0];

function person(fields: Partial<Target>): Target {
	return {
		email: "jane@example.com",
		id: "jane",
		name: "Jane",
		permissions: null,
		role: "developer",
		type: "human",
		...fields,
	} as Target;
}

let saved: string[] = [];
let admins = 2;
let accounts: Target[] = [];

beforeEach(() => {
	saved = [];
	admins = 2;
	accounts = [];
	stub(UserService, "countAdmins", async () => admins);
	stub(
		UserService,
		"getUser",
		async (id: string) => accounts.find((account) => account.id === id) ?? null,
	);
	stub(
		UserService,
		"findByEmail",
		async (email: string) =>
			accounts.find((account) => account.email === email) ?? null,
	);
	stub(
		UserService,
		"setRole",
		async (id: string, role: string, permissions: unknown) => {
			saved.push(`role ${id} ${role} ${JSON.stringify(permissions)}`);
		},
	);
	stub(
		UserService,
		"setPermissions",
		async (id: string, permissions: unknown) => {
			saved.push(`permissions ${id} ${JSON.stringify(permissions)}`);
		},
	);
	stub(UserService, "setEmail", async (id: string, email: string) => {
		saved.push(`email ${id} ${email}`);
	});
	stub(UserService, "setName", async (id: string, name: string) => {
		saved.push(`name ${id} ${name}`);
	});
	stub(UserService, "cleanupUserResources", async (id: string, by: string) => {
		saved.push(`cleanup ${id} by ${by}`);
	});
	stub(UserService, "deleteUser", async (id: string) => {
		saved.push(`delete ${id}`);
	});
});

afterEach(restoreStubs);

describe("UserService.updateAccount", () => {
	test("saves the role with its permissions, the email and the name", async () => {
		const jane = person({});
		accounts = [jane];

		expect(
			await UserService.updateAccount(jane, {
				email: "jane@corp.example",
				name: "Jane D.",
				permissions: { services: "write" },
				role: "custom",
			}),
		).toBeNull();
		expect(saved).toEqual([
			'role jane custom {"services":"write"}',
			"email jane jane@corp.example",
			"name jane Jane D.",
		]);
	});

	test("switching to custom without permissions starts from the previous role's", async () => {
		const viewer = person({ role: "viewer" });

		expect(
			await UserService.updateAccount(viewer, { role: "custom" }),
		).toBeNull();
		expect(saved).toHaveLength(1);
		expect(saved[0]).toStartWith("role jane custom {");
		expect(saved[0]).toContain('"services":"read"');
	});

	test("changes a custom user's permissions alone", async () => {
		const custom = person({ role: "custom" });

		expect(
			await UserService.updateAccount(custom, {
				permissions: { stacks: "read" },
			}),
		).toBeNull();
		expect(saved).toEqual(['permissions jane {"stacks":"read"}']);
	});

	test("refuses permissions without the custom role, before saving anything", async () => {
		expect(
			await UserService.updateAccount(person({}), {
				name: "Other",
				permissions: { services: "read" },
			}),
		).toBe("Only a custom-role user has their own permissions.");
		expect(saved).toEqual([]);
	});

	test("refuses demoting the last admin", async () => {
		const admin = person({ role: "admin" });
		accounts = [admin];
		admins = 1;

		expect(await UserService.updateAccount(admin, { role: "viewer" })).toBe(
			"Can't demote the last admin.",
		);
		expect(saved).toEqual([]);
	});

	test("refuses an email another account holds", async () => {
		accounts = [person({ email: "taken@example.com", id: "other" })];

		expect(
			await UserService.updateAccount(person({}), {
				email: "taken@example.com",
			}),
		).toBe("That email already has an account.");
		expect(saved).toEqual([]);
	});
});

describe("UserService.removeUser", () => {
	test("hands the resources over to the remover, then deletes the row", async () => {
		accounts = [person({})];

		expect(await UserService.removeUser("jane", "admin-1")).toBeNull();
		expect(saved).toEqual(["cleanup jane by admin-1", "delete jane"]);
	});

	test("refuses the caller's own account and the last admin", async () => {
		accounts = [person({ id: "boss", role: "admin" })];
		admins = 1;

		expect(await UserService.removeUser("boss", "boss")).toContain(
			"use Profile instead",
		);
		expect(await UserService.removeUser("boss", "someone")).toBe(
			"Can't remove the last admin.",
		);
		expect(saved).toEqual([]);
	});
});

describe("UserService.changePermissions", () => {
	test("only a custom-role user has their own permissions", async () => {
		expect(
			await UserService.changePermissions(person({}), { services: "read" }),
		).toBe("Only a custom-role user has their own permissions.");
		expect(
			await UserService.changePermissions(person({ role: "custom" }), {
				services: "read",
			}),
		).toBeNull();
		expect(saved).toEqual(['permissions jane {"services":"read"}']);
	});
});

describe("UserService.changeRole", () => {
	test("refuses demoting the last admin, and only that", async () => {
		const ada = person({ id: "ada", role: "admin" });
		accounts = [ada];
		admins = 1;
		expect(await UserService.changeRole(ada, "developer")).not.toBeNull();
		expect(await UserService.changeRole(ada, "admin")).toBeNull();
		expect(saved).toEqual(["role ada admin null"]);
	});

	test("switching to custom starts from the previous role's permissions", async () => {
		const jane = person({});
		accounts = [jane];
		expect(await UserService.changeRole(jane, "custom")).toBeNull();
		expect(saved[0]).toStartWith("role jane custom {");
		expect(saved[0]).toContain('"services":"write"');
	});
});

describe("UserService.changeEmail", () => {
	test("keeps the same address, refuses a taken one, saves a free one", async () => {
		const jane = person({});
		accounts = [jane, person({ email: "taken@example.com", id: "bob" })];
		expect(await UserService.changeEmail(jane, "jane@example.com")).toBeNull();
		expect(
			await UserService.changeEmail(jane, "taken@example.com"),
		).not.toBeNull();
		expect(await UserService.changeEmail(jane, "free@example.com")).toBeNull();
		expect(saved).toEqual(["email jane free@example.com"]);
	});
});
