import { cp } from "node:fs/promises";
import process from "node:process";
import type { Locator, Page } from "@playwright/test";
import { E2E_BASE_URL } from "../../support/config";
import { expect } from "../../support/test";
import { postAction, type Seeded, type ShotModule } from "./types";

const COMPOSE_FILES_DIR = "/tmp/homerun/compose";

const ids = {
	cronJob: "",
	database: "",
	destination: "",
	files: "",
	issue: "",
	statusPage: "",
	volume: "",
};

const RELEASE = "v1.4.2";

const QUIET_EVENTS = [
	"build.failed",
	"build.checks_failed",
	"update.failed",
	"deploy.unhealthy",
	"deploy.rolled_back",
	"backup.failed",
	"cron_job.failed",
];

/** Scrolls the dashboard's main pane so the panel holding `target` starts at its top edge. */
async function scrollToTop(target: Locator): Promise<void> {
	await target.first().evaluate((el) => {
		(el.closest("section") ?? el).scrollIntoView({ block: "start" });
		document.getElementById("main-content")?.scrollBy(0, -16);
	});
}

/** A panel heading, matched on its whole text when given a string. */
function heading(page: Page, name: string | RegExp): Locator {
	return page.getByRole(
		"heading",
		typeof name === "string" ? { exact: true, name } : { name },
	);
}

/** Reads `key` from a form action's result, which SvelteKit sends devalue-encoded. */
function actionField(body: unknown, key: string): string {
	const flat = JSON.parse((body as { data: string }).data) as unknown[];
	const root = flat[0] as Record<string, number>;
	return String(flat[root[key]]);
}

/** The id at the end of the page a form action redirected to. */
function redirectedId(body: unknown): string {
	return (body as { location: string }).location.split("/").at(-1) ?? "";
}

/** Reloads the Events section until the uptime probes have recorded a beat, capturing whatever is there after a minute and a half. */
async function waitForBeats(page: Page): Promise<void> {
	await expect(async () => {
		await page.reload();
		await expect(
			page.locator('span[title^="Up ·"], span[title^="Down ·"]').first(),
		).toBeVisible({ timeout: 2000 });
	})
		.toPass({ intervals: [5000], timeout: 90_000 })
		.catch(() => undefined);
}

/** A never-deployed Postgres in the Acme stack, so it gets its `<slug>-data` volume, with a monthly auto-redeploy. */
async function seedDatabase(page: Page, seeded: Seeded): Promise<void> {
	const res = await page.request.post("/api/v1/services", {
		data: {
			containerPort: 5432,
			dnsResolvable: false,
			envVars: {
				POSTGRES_DB: "acme",
				POSTGRES_PASSWORD: "change-me",
				POSTGRES_USER: "acme",
			},
			image: "postgres",
			name: "Main database",
			slug: "acme-db",
			stackId: seeded.stackId,
			tag: "18-alpine",
		},
	});
	expect(res.ok(), `creating acme-db: ${await res.text()}`).toBeTruthy();
	ids.database = (await res.json()).id;
	await postAction(page, `/services/${ids.database}/settings?/updateCron`, {
		cronEnabled: "on",
		cronSchedule: "0 4 1 * *",
	});
}

/** An S3 destination, a bind-mounted volume of config files, and monthly backups of the database's volume. */
async function seedStorage(page: Page): Promise<void> {
	ids.destination = actionField(
		await postAction(page, "/s3-destinations/new?/create", {
			accessKeyId: "AKIAEXAMPLE7Q2Z",
			bucket: "acme-backups",
			endpoint: "https://s3.eu-central-1.example.com",
			name: "Offsite bucket",
			region: "eu-central-1",
			secretAccessKey: "example-secret-access-key",
			type: "s3",
		}),
		"destinationId",
	);
	await cp(`${process.cwd()}/tools/compose`, COMPOSE_FILES_DIR, {
		recursive: true,
	});
	await postAction(page, "/storage/new?/create", {
		description: "The compose files this instance was set up from",
		kind: "bind",
		name: "compose-files",
		source: COMPOSE_FILES_DIR,
	});

	const res = await page.request.get("/api/v1/volumes");
	expect(res.ok(), `listing volumes: ${await res.text()}`).toBeTruthy();
	const volumes = (await res.json()) as { id: string; name: string }[];
	ids.volume = volumes.find((v) => v.name === "acme-db-data")?.id ?? "";
	ids.files = volumes.find((v) => v.name === "compose-files")?.id ?? "";
	if (!(ids.volume && ids.files)) {
		throw new Error("The acme-db-data or compose-files volume is missing.");
	}

	await postAction(page, `/storage/${ids.volume}?/updateBackup`, {
		backupEnabled: "on",
		backupPreCommand: "pg_dump -U acme -f /var/lib/postgresql/dump.sql acme",
		backupPreCommandServiceId: ids.database,
		backupPrefix: "acme/db",
		backupSchedule: "0 3 1 * *",
		s3DestinationId: ids.destination,
	});
}

/** A Sentry event for the API service, `exception` or `message` on top of what every event carries. */
function errorEvent(user: string, extra: Record<string, unknown>) {
	const now = Date.now() / 1000;
	return {
		breadcrumbs: {
			values: [
				{ category: "http", message: "POST /invoices", timestamp: now - 2 },
				{
					category: "query",
					message: "SELECT * FROM orders WHERE id = $1",
					timestamp: now - 1,
				},
			],
		},
		environment: "production",
		level: "error",
		platform: "node",
		release: RELEASE,
		request: { method: "POST", url: "https://acme-api.example.com/invoices" },
		sdk: { name: "sentry.javascript.node", version: "9.10.0" },
		server_name: "acme-api",
		tags: { route: "POST /invoices", runtime: "node v22.11.0" },
		timestamp: now,
		user: { id: user },
		...extra,
	};
}

const INVOICE_ERROR = {
	exception: {
		values: [
			{
				mechanism: { handled: false, type: "onunhandledrejection" },
				stacktrace: {
					frames: [
						{
							filename: "node_modules/express/lib/router/layer.js",
							function: "Layer.handle [as handle_request]",
							in_app: false,
							lineno: 95,
						},
						{
							abs_path: "/app/src/routes/invoices.ts",
							context_line: "    const invoice = await buildInvoice(order);",
							filename: "src/routes/invoices.ts",
							function: "createInvoice",
							in_app: true,
							lineno: 31,
							post_context: ["    res.status(201).json(invoice);", "  });"],
							pre_context: [
								"  router.post('/invoices', async (req, res) => {",
								"    const order = await orders.find(req.body.orderId);",
							],
						},
						{
							abs_path: "/app/src/billing/invoice.ts",
							context_line: "  const subtotal = order.totals.subtotal;",
							filename: "src/billing/invoice.ts",
							function: "buildInvoice",
							in_app: true,
							lineno: 42,
							post_context: [
								"  const tax = subtotal * order.taxRate;",
								"  return { lines, subtotal, tax, total: subtotal + tax };",
								"}",
							],
							pre_context: [
								"export async function buildInvoice(order: Order) {",
								"  const lines = order.items.map(toLine);",
							],
						},
					],
				},
				type: "TypeError",
				value: "Cannot read properties of undefined (reading 'subtotal')",
			},
		],
	},
};

const DATABASE_ERROR = {
	exception: {
		values: [
			{
				stacktrace: {
					frames: [
						{
							filename: "node_modules/pg-pool/index.js",
							function: "Pool.connect",
							in_app: false,
							lineno: 45,
						},
						{
							abs_path: "/app/src/db/pool.ts",
							context_line: "  const client = await pool.connect();",
							filename: "src/db/pool.ts",
							function: "getClient",
							in_app: true,
							lineno: 18,
						},
					],
				},
				type: "Error",
				value: "connect ECONNREFUSED 10.0.4.12:5432",
			},
		],
	},
};

/** Turns error tracking on for the API service, reports a few errors to it through its DSN, and uploads a release's source maps. */
async function seedErrors(page: Page, seeded: Seeded): Promise<void> {
	const api = seeded.serviceIds.api;
	await postAction(page, `/services/${api}/observability/errors?/enable`, {});
	await page.goto(`/services/${api}/observability/errors`);
	const dsn = await page
		.locator("code")
		.filter({ hasText: /^https?:\/\/\w+@/ })
		.first()
		.textContent();
	const parsed = new URL(dsn?.trim() ?? "");
	const store = `/api${parsed.pathname}/store/?sentry_key=${parsed.username}`;

	const events = [
		errorEvent("user_1042", INVOICE_ERROR),
		errorEvent("user_1187", INVOICE_ERROR),
		errorEvent("user_2210", INVOICE_ERROR),
		errorEvent("user_1042", DATABASE_ERROR),
		errorEvent("user_3051", DATABASE_ERROR),
		errorEvent("user_1187", {
			level: "warning",
			message: "Stripe webhook signature mismatch",
		}),
	];
	for (const data of events) {
		// oxlint-disable-next-line no-await-in-loop -- sent in order, so the counts and last-seen times read naturally
		const res = await page.request.post(store, { data });
		expect(res.ok(), `reporting an error: ${await res.text()}`).toBeTruthy();
	}

	const map = (file: string) => ({
		buffer: Buffer.from(
			JSON.stringify({
				file,
				mappings: "AAAA",
				names: [],
				sources: ["../../../src/routes/+page.svelte"],
				version: 3,
			}),
		),
		mimeType: "application/json",
		name: `${file}.map`,
	});
	const upload = await page.request.post(`/api/v1/services/${api}/sourcemaps`, {
		headers: { origin: E2E_BASE_URL },
		multipart: {
			"_app/immutable/entry/app.3f2a1c.js.map": map("app.3f2a1c.js"),
			"_app/immutable/entry/start.9b04de.js.map": map("start.9b04de.js"),
			release: RELEASE,
		},
	});
	expect(
		upload.ok(),
		`uploading source maps: ${await upload.text()}`,
	).toBeTruthy();

	const issues = await page.request.get(`/api/v1/services/${api}/errors`);
	ids.issue =
		((await issues.json()) as { id: string; title: string }[]).find((issue) =>
			issue.title.startsWith("TypeError"),
		)?.id ?? "";
}

/** Two notification channels, kept off the events this run could fire (resource alerts and new errors), so nothing is sent while the shots are taken. */
async function seedChannels(page: Page): Promise<void> {
	await postAction(page, "/notifications/settings/channels/new", {
		kind: "discord",
		name: "Ops alerts",
		target: "https://discord.com/api/webhooks/1234567890/example-token",
	});
	await postAction(page, "/notifications/settings/channels/new", {
		kind: "email",
		name: "On-call email",
		target: "oncall@example.com",
	});

	await page.goto("/notifications/settings");
	const fields = await page
		.locator('input[name^="channel:"]')
		.evaluateAll((els) => [
			...new Set(els.map((el) => (el as HTMLInputElement).name)),
		]);
	const rows = fields.flatMap((field) =>
		QUIET_EVENTS.map((event): [string, string] => [field, event]),
	);
	const res = await page.request.post("/notifications/settings?/save", {
		data: new URLSearchParams(rows).toString(),
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: E2E_BASE_URL,
			"x-sveltekit-action": "true",
		},
	});
	const body = await res.json();
	expect(
		res.ok() && body.type === "success" && fields.length > 0,
		`saving the subscriptions of ${fields.join(", ")}: ${JSON.stringify(body)}`,
	).toBeTruthy();
}

export const shots: ShotModule = {
	setup: async (page, seeded) => {
		if (!(seeded.stackId && seeded.serviceIds.api)) {
			throw new Error("The operations shots need the seeded Acme stack.");
		}
		await seedChannels(page);
		await seedDatabase(page, seeded);
		await seedStorage(page);
		await seedErrors(page, seeded);

		ids.cronJob = redirectedId(
			await postAction(page, "/cron-jobs/new?/create", {
				command: "wget -qO- http://acme-api:8080/tasks/prune-sessions",
				description: "Deletes sessions that expired more than a week ago.",
				enabled: "on",
				image: "alpine",
				kind: "image",
				name: "Prune expired sessions",
				schedule: "30 2 1 * *",
				tag: "3",
				timeoutSeconds: "300",
			}),
		);

		ids.statusPage = redirectedId(
			await postAction(page, "/status-pages/new", {
				description: "Live status of everything behind acme-web.example.com.",
				isPublic: "on",
				name: "Acme status",
				scope: "stack",
				slug: "acme",
				stackId: seeded.stackId,
			}),
		);
	},
	shots: [
		{
			doc: "/settings (Resource limits)",
			expect: /Resource limits/,
			name: "dashboard-resource-limits",
			path: () => "/settings",
			prepare: (page) => scrollToTop(heading(page, "Resource limits")),
		},
		{
			doc: "/storage",
			expect: /acme-db-data/,
			name: "storage-volumes-list",
			path: () => "/storage",
		},
		{
			doc: "/storage/:id/files (a file open in the editor)",
			expect: /base\.compose\.yaml/,
			name: "storage-volumes-files",
			path: () => `/storage/${ids.files}/files?file=base.compose.yaml`,
		},
		{
			doc: "/services/:id/volumes",
			expect: /acme-db-data/,
			name: "storage-volumes-service-tab",
			path: () => `/services/${ids.database}/volumes`,
		},
		{
			doc: "/s3-destinations/new (Preset picker open)",
			expect: /Add a backup destination/,
			name: "backups-destination-new",
			path: () => "/s3-destinations/new",
			prepare: async (page) => {
				await page.locator("#preset").click();
				await expect(
					page.getByRole("option", { name: "Hetzner Storage Box" }),
				).toBeVisible();
			},
		},
		{
			doc: "/s3-destinations/:id",
			expect: /Volumes backed up here/,
			name: "backups-destination",
			path: () => `/s3-destinations/${ids.destination}`,
		},
		{
			doc: "/storage/:id (S3 backup)",
			expect: /Enable scheduled backups/,
			name: "backups-volume",
			path: () => `/storage/${ids.volume}`,
		},
		{
			doc: "/backups",
			expect: /acme-db-data/,
			name: "backups-history",
			path: () => "/backups",
		},
		{
			doc: "/storage/:id (Restore)",
			expect: /Unpacks a backup from/,
			name: "backups-restore",
			path: () => `/storage/${ids.volume}`,
			prepare: (page) => scrollToTop(heading(page, "Restore")),
		},
		{
			doc: "/services/:id/settings (Auto-redeploy schedule)",
			expect: /Auto-redeploy schedule/,
			name: "scheduling-cron-redeploy",
			path: () => `/services/${ids.database}/settings`,
			prepare: (page) => scrollToTop(heading(page, "Auto-redeploy schedule")),
		},
		{
			doc: "/cron-jobs/:id",
			expect: /Prune expired sessions/,
			name: "scheduling-cron-job",
			path: () => `/cron-jobs/${ids.cronJob}`,
		},
		{
			doc: "/scheduling (Job queue)",
			expect: /Job queue/,
			name: "scheduling-job-queue",
			path: () => "/scheduling",
			prepare: async (page) => {
				await expect(page.getByText("Succeeded").first()).toBeVisible();
			},
		},
		{
			doc: "/scheduling (cron redeploys, cron jobs and backups)",
			expect: /Prune expired sessions/,
			name: "scheduling-overview",
			path: () => "/scheduling",
			prepare: (page) => scrollToTop(heading(page, "Cron redeploys")),
		},
		{
			doc: "/docker-cleanup",
			expect: /Quick cleanup/,
			name: "docker-cleanup",
			path: () => "/docker-cleanup",
		},
		{
			doc: "/docker-cleanup (Image mirror)",
			expect: /Quick cleanup/,
			name: "docker-cleanup-mirror",
			path: () => "/docker-cleanup",
			prepare: async (page) => {
				await scrollToTop(heading(page, "Image mirror"));
				await expect(
					page
						.getByText(
							/The mirror isn't running|on disk|cleanup in progress|Couldn't read the mirror's size/,
						)
						.first(),
				).toBeVisible();
			},
		},
		{
			doc: "/system-logs",
			expect: /Application errors/,
			name: "system-logs",
			path: () => "/system-logs",
			prepare: async (page) => {
				await expect(
					page
						.getByText(/This instance's stack|No stack containers found/)
						.first(),
				).toBeVisible();
			},
		},
		{
			doc: "/services/:id/observability/events (Uptime)",
			expect: /From the network/,
			name: "observability-uptime",
			path: (seeded) =>
				`/services/${seeded.serviceIds.web}/observability/events`,
			prepare: waitForBeats,
		},
		{
			doc: "/services/:id/observability/events (Logs)",
			expect: /Reconnect/,
			name: "observability-logs",
			path: (seeded) =>
				`/services/${seeded.serviceIds.web}/observability/events`,
			prepare: (page) => scrollToTop(heading(page, "Logs")),
		},
		{
			doc: "/services/:id/observability/events (Failed deployments, Application errors)",
			expect: /Failed deployments/,
			name: "observability-errors",
			path: (seeded) =>
				`/services/${seeded.serviceIds.web}/observability/events`,
			prepare: (page) => scrollToTop(heading(page, /^\s*Failed deployments/)),
		},
		{
			doc: "/services/:id/terminal",
			expect: /inside this service's live container/,
			name: "observability-terminal",
			path: (seeded) => `/services/${seeded.serviceIds.web}/terminal`,
			prepare: async (page) => {
				await expect(
					page.getByText("connected", { exact: true }),
				).toBeVisible();
				await page.locator(".xterm").click();
				for (const command of ["nginx -v", "ls /usr/share/nginx/html"]) {
					// oxlint-disable-next-line no-await-in-loop -- typed one after the other, like a person would
					await page.keyboard.type(command);
					// oxlint-disable-next-line no-await-in-loop -- runs the line just typed
					await page.keyboard.press("Enter");
				}
			},
		},
		{
			doc: "/services/:id/observability/errors (SDK setup open)",
			expect: /Public DSN/,
			name: "error-tracking-setup",
			path: (seeded) =>
				`/services/${seeded.serviceIds.api}/observability/errors`,
			prepare: async (page) => {
				await page.getByText("SDK setup", { exact: true }).click();
				await expect(
					page.getByRole("button", { exact: true, name: "Node.js" }),
				).toBeVisible();
			},
		},
		{
			doc: "/services/:id/observability/errors (issues)",
			expect: /Cannot read properties of undefined/,
			name: "error-tracking-issues",
			path: (seeded) =>
				`/services/${seeded.serviceIds.api}/observability/errors`,
			prepare: (page) =>
				scrollToTop(
					page.getByPlaceholder("Search issues by title or culprit…"),
				),
		},
		{
			doc: "/services/:id/observability/errors/:issueId",
			expect: /Cannot read properties of undefined/,
			name: "error-tracking-issue",
			path: (seeded) =>
				`/services/${seeded.serviceIds.api}/observability/errors/${ids.issue}`,
		},
		{
			doc: "/services/:id/observability/errors (Source maps)",
			expect: /Public DSN/,
			name: "error-tracking-source-maps",
			path: (seeded) =>
				`/services/${seeded.serviceIds.api}/observability/errors`,
			prepare: (page) => scrollToTop(heading(page, "Source maps")),
		},
		{
			doc: "/notifications",
			expect: /Each account reads and clears its own copy/,
			name: "notifications-bell",
			path: () => "/notifications",
		},
		{
			doc: "/notifications/settings/channels",
			expect: /Ops alerts/,
			name: "notifications-channels",
			path: () => "/notifications/settings/channels",
		},
		{
			doc: "/notifications/settings",
			expect: /What to send, and where/,
			name: "notifications-subscriptions",
			path: () => "/notifications/settings",
		},
		{
			doc: "/status-pages/:id",
			expect: /Tracked services/,
			name: "status-pages-dashboard",
			path: () => `/status-pages/${ids.statusPage}`,
		},
		{
			doc: "/status/:slug",
			expect: /Acme status/,
			name: "status-pages-public",
			path: () => "/status/acme",
		},
	],
};
