import {
	afterAll,
	afterEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const refreshToken = mock(
	async (_input: { body: { accountId: string; userId: string } }) => ({}),
);

mock.module("#lib/services/auth.js", () => ({
	auth: { api: { refreshToken } },
	rebuildAuth: () => undefined,
}));

const { db } = await import("../../../src/lib/server/db/lib");
const { account: accountTable, user: userTable } = await import(
	"../../../src/lib/server/db/schema"
);
const { ACCESS_DENIAL_MESSAGES, AppAccessService, sharedAppLinks } =
	await import("../../../src/lib/services/app-access.service");
const { ServiceDTO } = await import("../../../src/lib/dto/service-dto");
const { StackDTO } = await import("../../../src/lib/dto/stack-dto");
const { applyInstanceSettings, config } = await import(
	"../../../src/lib/config"
);
const { InstanceSettingsDTO } = await import(
	"../../../src/lib/dto/instance-settings-dto"
);

type Service = Parameters<typeof AppAccessService.evaluate>[0];

interface UserRow {
	banExpires: Date | null;
	banned: boolean | null;
	email: string;
	role: string | null;
	type?: string;
}

interface AccountRow {
	id: string;
	idToken: string | null;
	providerId: string;
	refreshToken: string | null;
}

const tables = { accounts: [] as AccountRow[], users: [] as UserRow[] };

function rowsQuery(rows: unknown[]) {
	const result = Promise.resolve(rows);
	return Object.assign(result, { limit: async () => rows });
}

const selectSpy = spyOn(db, "select").mockImplementation((() => ({
	from: (table: unknown) => ({
		where: () =>
			rowsQuery(
				table === userTable
					? tables.users
					: table === accountTable
						? tables.accounts
						: [],
			),
	}),
})) as unknown as typeof db.select);

afterAll(() => {
	selectSpy.mockRestore();
});

afterEach(() => {
	tables.users = [];
	tables.accounts = [];
	refreshToken.mockReset();
	refreshToken.mockImplementation(async () => ({}));
});

function idTokenWith(claims: Record<string, unknown>): string {
	return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

function service(overrides: Partial<Record<string, string[]>> = {}): Service {
	return {
		authAllowedEmails: [],
		authAllowedGroups: [],
		authAllowedUserIds: [],
		authProviders: ["oauth:keycloak"],
		...overrides,
	} as unknown as Service;
}

const ada: UserRow = {
	banExpires: null,
	banned: false,
	email: "ada@example.com",
	role: "user",
};

function keycloakAccount(groups: string[], id = "acc-1"): AccountRow {
	return {
		id,
		idToken: idTokenWith({ groups }),
		providerId: "keycloak",
		refreshToken: "rt",
	};
}

describe("AppAccessService.evaluate", () => {
	const robot: UserRow = {
		banExpires: null,
		banned: false,
		email: "sa-1@service-account.homerun.invalid",
		role: "custom",
		type: "service-account",
	};

	test("a service account passes on its key alone, but only when listed by id", async () => {
		tables.users = [robot];
		expect(
			await AppAccessService.evaluate(
				service({
					authAllowedEmails: ["*@example.com"],
					authAllowedGroups: ["platform"],
					authAllowedUserIds: ["sa-1"],
					authProviders: ["email-otp"],
				}),
				"sa-1",
			),
		).toEqual({ allowed: true });
		expect(await AppAccessService.evaluate(service(), "sa-1")).toEqual({
			allowed: false,
			reason: "user-not-allowed",
		});
	});

	test("a disabled service account is refused even when listed", async () => {
		tables.users = [{ ...robot, banned: true }];
		expect(
			await AppAccessService.evaluate(
				service({ authAllowedUserIds: ["sa-1"] }),
				"sa-1",
			),
		).toEqual({ allowed: false, reason: "user-not-allowed" });
	});

	test("nobody passes a wall with no sign-in method", async () => {
		expect(
			await AppAccessService.evaluate(service({ authProviders: [] }), "u1"),
		).toEqual({ allowed: false, reason: "no-method-configured" });
	});

	test("an explicit user list shuts everyone else out before touching the DB", async () => {
		selectSpy.mockClear();
		expect(
			await AppAccessService.evaluate(
				service({ authAllowedUserIds: ["u2"] }),
				"u1",
			),
		).toEqual({ allowed: false, reason: "user-not-allowed" });
		expect(selectSpy).not.toHaveBeenCalled();
	});

	test("a deleted or banned user is refused", async () => {
		tables.accounts = [keycloakAccount([])];
		expect(await AppAccessService.evaluate(service(), "u1")).toEqual({
			allowed: false,
			reason: "user-not-allowed",
		});
		tables.users = [{ ...ada, banned: true }];
		expect(await AppAccessService.evaluate(service(), "u1")).toEqual({
			allowed: false,
			reason: "user-not-allowed",
		});
	});

	test("the email allowlist accepts wildcards and refuses anyone else", async () => {
		tables.users = [ada];
		tables.accounts = [keycloakAccount([])];
		expect(
			await AppAccessService.evaluate(
				service({ authAllowedEmails: ["*@example.com"] }),
				"u1",
			),
		).toEqual({ allowed: true });
		expect(
			await AppAccessService.evaluate(
				service({ authAllowedEmails: ["bob@example.com"] }),
				"u1",
			),
		).toEqual({ allowed: false, reason: "email-not-allowed" });
	});

	test("an account linked only to another method is refused", async () => {
		tables.users = [ada];
		tables.accounts = [
			{ id: "a", idToken: null, providerId: "credential", refreshToken: null },
		];
		expect(await AppAccessService.evaluate(service(), "u1")).toEqual({
			allowed: false,
			reason: "method-not-linked",
		});
		expect(
			await AppAccessService.evaluate(
				service({ authProviders: ["password"] }),
				"u1",
			),
		).toEqual({ allowed: true });
	});

	test("an emailed code or link lets any account through while it's available", async () => {
		tables.users = [ada];
		const settings = spyOn(InstanceSettingsDTO, "get").mockImplementation(
			async () =>
				({
					emailSignIn: { emailOtp: true, magicLink: false },
				}) as unknown as Awaited<ReturnType<typeof InstanceSettingsDTO.get>>,
		);
		try {
			const otpWall = service({ authProviders: ["email-otp"] });
			expect(await AppAccessService.evaluate(otpWall, "u1")).toEqual({
				allowed: false,
				reason: "method-not-linked",
			});

			applyInstanceSettings({
				smtpEnabled: true,
				smtpFrom: "homerun@example.com",
				smtpHost: "smtp.example.com",
				smtpPassword: "pw",
				smtpPort: 587,
				smtpUser: "mailer",
			});
			expect(await AppAccessService.evaluate(otpWall, "u1")).toEqual({
				allowed: true,
			});
			expect(
				await AppAccessService.evaluate(
					service({ authProviders: ["magic-link"] }),
					"u1",
				),
			).toEqual({ allowed: false, reason: "method-not-linked" });
			expect(
				await AppAccessService.evaluate(
					service({
						authAllowedEmails: ["bob@example.com"],
						authProviders: ["email-otp"],
					}),
					"u1",
				),
			).toEqual({ allowed: false, reason: "email-not-allowed" });
		} finally {
			settings.mockRestore();
			applyInstanceSettings({});
		}
	});

	test("groups come from the provider's id token or the Homerun role", async () => {
		tables.users = [ada];
		tables.accounts = [keycloakAccount(["devs"])];
		expect(
			await AppAccessService.evaluate(
				service({ authAllowedGroups: ["devs"] }),
				"u1",
			),
		).toEqual({ allowed: true });
		expect(
			await AppAccessService.evaluate(
				service({ authAllowedGroups: ["user"] }),
				"u1",
			),
		).toEqual({ allowed: true });
		expect(
			await AppAccessService.evaluate(
				service({ authAllowedGroups: ["admins"] }),
				"u1",
			),
		).toEqual({ allowed: false, reason: "group-not-allowed" });
	});

	test("every denial reason has a message", () => {
		for (const message of Object.values(ACCESS_DENIAL_MESSAGES)) {
			expect(message.length).toBeGreaterThan(0);
		}
	});
});

describe("AppAccessService.recheck", () => {
	test("without a group filter it never asks the provider for fresh tokens", async () => {
		tables.users = [ada];
		tables.accounts = [keycloakAccount([])];
		expect(await AppAccessService.recheck(service(), "plain-user")).toBe(true);
		expect(refreshToken).not.toHaveBeenCalled();
	});

	test("with a group filter it refreshes OAuth accounts at most once every five minutes", async () => {
		tables.users = [ada];
		tables.accounts = [
			keycloakAccount(["devs"], "acc-kc"),
			{
				id: "acc-pw",
				idToken: null,
				providerId: "credential",
				refreshToken: "x",
			},
		];
		const svc = service({
			authAllowedGroups: ["devs"],
			authProviders: ["oauth:keycloak", "password"],
		});

		expect(await AppAccessService.recheck(svc, "grouped-user")).toBe(true);
		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(refreshToken.mock.calls[0][0]).toEqual({
			body: { accountId: "acc-kc", userId: "grouped-user" },
		});

		await AppAccessService.recheck(svc, "grouped-user");
		expect(refreshToken).toHaveBeenCalledTimes(1);

		const realNow = Date.now;
		Date.now = () => realNow() + 6 * 60 * 1000;
		try {
			await AppAccessService.recheck(svc, "grouped-user");
		} finally {
			Date.now = realNow;
		}
		expect(refreshToken).toHaveBeenCalledTimes(2);
	});

	test("a failed refresh falls back to the stored token's groups", async () => {
		tables.users = [ada];
		tables.accounts = [keycloakAccount(["devs"])];
		refreshToken.mockImplementation(async () => {
			throw new Error("provider down");
		});
		expect(
			await AppAccessService.recheck(
				service({ authAllowedGroups: ["devs"] }),
				"failing-refresh-user",
			),
		).toBe(true);
		expect(refreshToken).toHaveBeenCalledTimes(1);
	});

	test("no refreshable account means no refresh call, and the group check still applies", async () => {
		tables.users = [ada];
		tables.accounts = [{ ...keycloakAccount(["devs"]), refreshToken: null }];
		expect(
			await AppAccessService.recheck(
				service({ authAllowedGroups: ["ops"] }),
				"no-refresh-user",
			),
		).toBe(false);
		expect(refreshToken).not.toHaveBeenCalled();
	});
});

function appRow(overrides: Record<string, unknown> = {}) {
	return {
		channelCanary: false,
		defaultDomainEnabled: true,
		dnsResolvable: true,
		domains: [],
		id: "svc",
		name: "App",
		previewPrNumber: null,
		previewPrTitle: null,
		primaryDomain: null,
		slug: "app",
		...overrides,
	} as Parameters<typeof sharedAppLinks>[0][number]["row"];
}

describe("sharedAppLinks", () => {
	test("links each app's primary hostname over https, sorted by name", () => {
		expect(
			sharedAppLinks(
				[
					{
						row: appRow({ id: "w", name: "Wiki", slug: "wiki" }),
						stackSlug: "docs",
					},
					{
						row: appRow({
							domains: ["books.example.org"],
							id: "b",
							name: "Books",
							primaryDomain: "books.example.org",
						}),
						stackSlug: null,
					},
				],
				"example.com",
			),
		).toEqual([
			{
				canary: false,
				id: "b",
				name: "Books",
				pullRequest: null,
				url: "https://books.example.org",
			},
			{
				canary: false,
				id: "w",
				name: "Wiki",
				pullRequest: null,
				url: "https://docs-wiki.example.com",
			},
		]);
	});

	test("skips an app with nothing routed or kept out of DNS", () => {
		expect(
			sharedAppLinks(
				[
					{ row: appRow({ defaultDomainEnabled: false }), stackSlug: null },
					{ row: appRow({ dnsResolvable: false }), stackSlug: null },
				],
				"example.com",
			),
		).toEqual([]);
	});

	test("a pull request preview carries its number and title", () => {
		const [link] = sharedAppLinks(
			[
				{
					row: appRow({
						name: "App PR #7",
						previewPrNumber: 7,
						previewPrTitle: "New checkout",
						slug: "app-pr-7",
					}),
					stackSlug: null,
				},
			],
			"example.com",
		);
		expect(link.pullRequest).toEqual({ number: 7, title: "New checkout" });
		expect(link.url).toBe("https://app-pr-7.example.com");
	});

	test("a release channel canary is flagged as the canary, not a pull request", () => {
		const [link] = sharedAppLinks(
			[
				{
					row: appRow({
						channelCanary: true,
						previewPrNumber: 3,
						slug: "app-canary",
					}),
					stackSlug: null,
				},
			],
			"example.com",
		);
		expect(link.canary).toBe(true);
		expect(link.pullRequest).toBeNull();
	});
});

describe("AppAccessService.sharedApps", () => {
	function gated(overrides: Record<string, unknown>) {
		const row = {
			...appRow(overrides),
			authAllowedEmails: [],
			authAllowedGroups: [],
			authAllowedUserIds: [],
			authProviders: ["password"],
			authRequired: true,
			stackId: null,
			...overrides,
		};
		return { ...row, toJSON: () => row } as unknown as Service;
	}

	test("lists only the gated apps whose wall lets the user through", async () => {
		tables.users = [ada];
		tables.accounts = [
			{ id: "a", idToken: null, providerId: "credential", refreshToken: null },
		];
		const listSpy = spyOn(ServiceDTO, "list").mockResolvedValue([
			gated({ id: "open", name: "Open", slug: "open" }),
			gated({ authAllowedUserIds: ["someone-else"], id: "shut", name: "Shut" }),
			gated({ authRequired: false, id: "public", name: "Public" }),
			gated({ id: "stacked", name: "Stacked", slug: "web", stackId: "s1" }),
		]);
		const stackSpy = spyOn(StackDTO, "list").mockResolvedValue([
			{ id: "s1", slug: "shop" },
		] as unknown as Awaited<ReturnType<typeof StackDTO.list>>);
		try {
			const apps = await AppAccessService.sharedApps("u1");
			expect(apps.map((app) => [app.id, app.url])).toEqual([
				["open", `https://open.${config.baseDomain}`],
				["stacked", `https://shop-web.${config.baseDomain}`],
			]);
		} finally {
			listSpy.mockRestore();
			stackSpy.mockRestore();
		}
	});

	test("skips the stack lookup when nothing is shared", async () => {
		const listSpy = spyOn(ServiceDTO, "list").mockResolvedValue([]);
		const stackSpy = spyOn(StackDTO, "list");
		try {
			expect(await AppAccessService.sharedApps("u1")).toEqual([]);
			expect(stackSpy).not.toHaveBeenCalled();
		} finally {
			listSpy.mockRestore();
			stackSpy.mockRestore();
		}
	});
});
