import type { Page } from "@playwright/test";
import { E2E_BASE_URL } from "../../support/config";
import { expect } from "../../support/test";
import { postAction, type ShotModule } from "./types";

const ids = {
	db: "",
	domainPath: "",
	git: "",
	redirect: "",
	subStack: "",
	template: "",
	worker: "",
};

const DB_PASSWORD = "change-me";

const WORKER_ENV: [string, string][] = [
	["DATABASE_URL", `postgres://jobs:${DB_PASSWORD}@acme-jobs-db:5432/jobs`],
	["REDIS_URL", "redis://cache:6379"],
	["QUEUE_NAME", "emails"],
	["CONCURRENCY", "4"],
	["LOG_LEVEL", "info"],
	["SMTP_HOST", "smtp.example.com"],
	["SMTP_PORT", "587"],
	["SMTP_USER", "mailer"],
	["SMTP_PASSWORD", "m4iler-s3cret"],
	["TMDB_API", "example-tmdb-key"],
	["SENTRY_DSN", "https://key@errors.example.com/3"],
];

const WORKER_SECRETS = ["SMTP_PASSWORD", "TMDB_API"];

const COMPOSE = [
	"services:",
	"  ghost:",
	"    image: ghost:5-alpine",
	"    restart: unless-stopped",
	"    ports:",
	'      - "2368:2368"',
	"    environment:",
	"      database__client: mysql",
	"      database__connection__host: db",
	"      database__connection__user: ghost",
	"      database__connection__password: change-me",
	"      database__connection__database: ghost",
	"      url: https://blog.example.com",
	"    volumes:",
	"      - ghost-content:/var/lib/ghost/content",
	"    depends_on:",
	"      - db",
	"    healthcheck:",
	'      test: ["CMD", "wget", "-qO-", "http://localhost:2368"]',
	"  db:",
	"    image: mysql:8.4",
	"    restart: unless-stopped",
	"    environment:",
	"      MYSQL_ROOT_PASSWORD: change-me",
	"      MYSQL_DATABASE: ghost",
	"      MYSQL_USER: ghost",
	"      MYSQL_PASSWORD: change-me",
	"    volumes:",
	"      - db-data:/var/lib/mysql",
	"    cap_drop:",
	"      - ALL",
	"volumes:",
	"  ghost-content:",
	"  db-data:",
	"secrets:",
	"  db-password:",
	"    file: ./db-password.txt",
	"",
].join("\n");

/** Creates a service through the REST API without deploying it, returning its id. */
async function createService(
	page: Page,
	data: Record<string, unknown>,
): Promise<string> {
	const res = await page.request.post("/api/v1/services", { data });
	expect(res.ok(), `creating ${data.slug}: ${await res.text()}`).toBeTruthy();
	return (await res.json()).id;
}

/** Submits a form action whose fields repeat (env rows), which `postAction`'s flat record can't express. */
async function postRows(
	page: Page,
	path: string,
	rows: [string, string][],
): Promise<void> {
	const res = await page.request.post(path, {
		data: new URLSearchParams(rows).toString(),
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: E2E_BASE_URL,
			"x-sveltekit-action": "true",
		},
	});
	const body = await res.json();
	expect(
		res.ok() && body.type === "success",
		`${path} refused: ${JSON.stringify(body)}`,
	).toBeTruthy();
}

/** Scrolls the panel holding `heading` to the top of the viewport. */
async function scrollToSection(page: Page, heading: string): Promise<void> {
	await page
		.getByRole("heading", { exact: true, name: heading })
		.first()
		.evaluate((el) =>
			(el.closest("section") ?? el).scrollIntoView({ block: "start" }),
		);
}

/** Waits for a toast to show and go again, so it isn't in the picture. */
async function waitOutToast(page: Page, text: string): Promise<void> {
	await expect(page.getByText(text).first()).toBeHidden({ timeout: 15_000 });
}

/** A Jobs substack under Acme with a worker and its database, linked to Acme's cache. */
async function seedJobs(page: Page, stackId: string, cacheId: string) {
	const stack = await page.request.post("/api/v1/stacks", {
		data: {
			description: "Background jobs and the database they write to.",
			name: "Jobs",
			slug: "acme-jobs",
		},
	});
	expect(
		stack.ok(),
		`creating the Jobs stack: ${await stack.text()}`,
	).toBeTruthy();
	ids.subStack = (await stack.json()).id;
	await postAction(page, `/stacks/${ids.subStack}/settings?/move`, {
		parentId: stackId,
	});

	ids.db = await createService(page, {
		containerPort: 5432,
		dnsResolvable: false,
		envVars: {
			POSTGRES_DB: "jobs",
			POSTGRES_PASSWORD: DB_PASSWORD,
			POSTGRES_USER: "jobs",
		},
		image: "postgres",
		name: "Postgres",
		slug: "acme-jobs-db",
		stackId: ids.subStack,
		tag: "17-alpine",
	});

	ids.worker = await createService(page, {
		command: ["node", "dist/worker.js", "--concurrency", "4"],
		containerPort: 8080,
		dnsResolvable: false,
		envFiles: ["/opt/acme/worker.env"],
		envVars: Object.fromEntries(WORKER_ENV),
		image: "ghcr.io/acme/worker",
		labels: { "com.acme.team": "growth" },
		name: "Queue worker",
		registryPassword: "ghp_exampleTokenForScreenshots",
		registryUrl: "ghcr.io",
		registryUsername: "acme-bot",
		runAsUser: "1000:1000",
		slug: "acme-jobs-worker",
		stackId: ids.subStack,
		tag: "2.4.1",
	});
	await postRows(
		page,
		`/services/${ids.worker}/environments/variables?/update`,
		[
			...WORKER_ENV.flatMap(([key, value]): [string, string][] => [
				["envKey", key],
				["envValue", value],
			]),
			...WORKER_SECRETS.map((key): [string, string] => ["envSecret", key]),
		],
	);
	const deps = await page.request.put(
		`/api/v1/services/${ids.worker}/dependencies`,
		{ data: { dependsOn: [ids.db, cacheId] } },
	);
	expect(
		deps.ok(),
		`recording dependencies: ${await deps.text()}`,
	).toBeTruthy();
}

/** A Gitea service outside any stack, on its own domain, with its SSH port published. */
async function seedGit(page: Page) {
	ids.git = await createService(page, {
		containerPort: 3000,
		envVars: {
			GITEA__server__ROOT_URL: "https://git.acme.dev",
			GITEA__server__SSH_PORT: "2222",
		},
		image: "gitea/gitea",
		name: "Gitea",
		slug: "acme-git",
		tag: "latest",
	});
	const patched = await page.request.patch(`/api/v1/services/${ids.git}`, {
		data: { domains: ["git.acme.dev"] },
	});
	expect(
		patched.ok(),
		`adding git.acme.dev: ${await patched.text()}`,
	).toBeTruthy();
	await postAction(
		page,
		`/services/${ids.git}/networking?/updatePublishedPorts`,
		{
			publishedPorts: JSON.stringify([
				{ containerPort: 22, hostPort: 2222, protocol: "tcp" },
			]),
		},
	);
}

/** Three redirects in different states, keeping the id of the one the edit shot opens. */
async function seedRedirects(page: Page) {
	const redirects = [
		{
			destination: "https://example.com",
			keepPath: true,
			permanent: true,
			source: "old.example.com",
		},
		{
			destination: "https://blog.example.com",
			keepPath: true,
			permanent: false,
			source: "news.example.com/blog",
		},
		{
			destination: "https://example.com/store",
			enabled: false,
			keepPath: false,
			permanent: false,
			source: "shop.example.com",
		},
	];
	const created = await Promise.all(
		redirects.map(async (data) => {
			const res = await page.request.post("/api/v1/redirects", { data });
			expect(
				res.ok(),
				`creating ${data.source}: ${await res.text()}`,
			).toBeTruthy();
			return (await res.json()) as { id: string; source: string };
		}),
	);
	ids.redirect =
		created.find((redirect) => redirect.source === "news.example.com/blog")
			?.id ?? "";
}

export const shots: ShotModule = {
	setup: async (page, seeded) => {
		const stackId = seeded.stackId;
		const cacheId = seeded.serviceIds.cache;
		if (!(stackId && cacheId)) {
			throw new Error("The platform shots need the seeded Acme stack.");
		}
		await seedJobs(page, stackId, cacheId);
		await seedGit(page);
		await seedRedirects(page);

		await Promise.all(
			["ci-pipeline", "ada-laptop"].map((username) =>
				postAction(page, "/registry/tokens?/create", { username }),
			),
		);

		await postAction(page, "/terminal?/configure", {
			host: "host.docker.internal",
			machineId: "local",
			port: "",
			user: "deploy",
		});

		const templates = await page.request.get("/api/v1/templates?q=WordPress");
		const wordpress = (
			(await templates.json()) as { id: string; name: string }[]
		).find((template) => template.name === "WordPress");
		if (!wordpress) {
			throw new Error("The WordPress built-in template is missing.");
		}
		ids.template = wordpress.id;

		await page.goto("/dns");
		const domainPath = await page
			.locator('a[href*="/dns/domains/"]')
			.filter({ hasText: /^\s*example\.com/ })
			.first()
			.getAttribute("href");
		if (!domainPath) {
			throw new Error("The example.com domain isn't listed on /dns.");
		}
		ids.domainPath = domainPath;
	},
	shots: [
		{
			doc: "/services/new?stackId= (Environment step, Link a service)",
			expect: /Deploy a Service/,
			name: "env-vars-link-a-service",
			path: (seeded) => `/services/new?stackId=${seeded.stackId}`,
			prepare: async (page) => {
				await page
					.getByRole("button", { name: /Environment$/ })
					.first()
					.click();
				await page
					.getByRole("button", { exact: true, name: "Link a service" })
					.click();
				await page.locator("#linkService-stack").click();
				await page
					.getByRole("option", { name: /^Cache/ })
					.first()
					.click();
				await expect(page.getByText(/reachable at/).first()).toBeVisible();
			},
		},
		{
			doc: "/services/:id (Connections)",
			expect: /Connections/,
			name: "env-vars-connections",
			path: () => `/services/${ids.worker}`,
			prepare: async (page) => {
				await page
					.getByRole("heading", { exact: true, name: "Connections" })
					.scrollIntoViewIfNeeded();
			},
		},
		{
			doc: "/services/:id/environments/variables (secret variables)",
			expect: /Environment variables/,
			name: "env-vars-secret",
			path: () => `/services/${ids.worker}/environments/variables`,
		},
		{
			doc: "/services/:id/environments/variables (Env files)",
			expect: /Environment variables/,
			name: "env-vars-env-files",
			path: () => `/services/${ids.worker}/environments/variables`,
			prepare: (page) => scrollToSection(page, "Env files"),
		},
		{
			doc: "/settings/networking (HTTP cache)",
			expect: /HTTP cache/,
			name: "networking-http-cache",
			path: () => "/settings/networking",
			prepare: async (page) => {
				await page
					.getByText("HTTP cache", { exact: true })
					.scrollIntoViewIfNeeded();
			},
		},
		{
			doc: "/services/:id/networking (Published ports)",
			expect: /Published ports/,
			name: "networking-published-ports",
			path: () => `/services/${ids.git}/networking`,
			prepare: (page) => scrollToSection(page, "Published ports"),
		},
		{
			doc: "/services/:id/networking (SSL)",
			expect: /Certificate \(PEM\)/,
			name: "networking-custom-ssl",
			path: () => `/services/${ids.git}/networking`,
			prepare: (page) => scrollToSection(page, "SSL"),
		},
		{
			doc: "/settings/tls",
			expect: /Instance certificate/,
			name: "networking-instance-certificate",
			path: () => "/settings/tls",
		},
		{
			doc: "/redirects",
			expect: /old\.example\.com/,
			name: "redirects-list",
			path: () => "/redirects",
		},
		{
			doc: "/redirects/:id",
			expect: /Keep the path and query string/,
			name: "redirects-edit",
			path: () => `/redirects/${ids.redirect}`,
		},
		{
			doc: "/dns/providers (Connect a provider, Cloudflare picked)",
			expect: /Connect a provider/,
			name: "dns-automation-provider-form",
			path: () => "/dns/providers",
			prepare: async (page) => {
				await page.getByRole("button", { name: "Connect a provider" }).click();
				await page
					.getByRole("button", { exact: true, name: "Provider" })
					.click();
				await page
					.getByRole("option", { exact: true, name: "Cloudflare" })
					.click();
				await expect(
					page.getByText("How to create Cloudflare credentials:"),
				).toBeVisible();
			},
		},
		{
			doc: "/dns/domains/:id",
			expect: /Records point at/,
			name: "dns-automation-domain",
			path: () => ids.domainPath,
		},
		{
			doc: "/dns/pangolin",
			expect: /Use Pangolin/,
			name: "dns-automation-pangolin",
			path: () => "/dns/pangolin",
		},
		{
			doc: "/services/:id/container/runtime",
			expect: /Run as user/,
			name: "runtime-and-compute-runtime",
			path: () => `/services/${ids.worker}/container/runtime`,
		},
		{
			doc: "/settings/docker (Orchestration)",
			expect: /What swarm mode doesn.t do/,
			name: "swarm-mode-orchestration",
			path: () => "/settings/docker",
			prepare: (page) => scrollToSection(page, "Orchestration"),
		},
		{
			doc: "/services/import (a parsed compose file)",
			expect: /Import a compose file/,
			name: "compose-import-preview",
			path: () => "/services/import",
			prepare: async (page) => {
				await page.locator("#compose").fill(COMPOSE);
				await page.getByRole("button", { exact: true, name: "Parse" }).click();
				await expect(
					page.getByText("Not everything maps onto Homerun"),
				).toBeVisible();
				await waitOutToast(page, "Parsed : review what gets created below.");
				await page
					.getByRole("button", { exact: true, name: "Parse" })
					.evaluate((el) => el.scrollIntoView({ block: "start" }));
			},
		},
		{
			doc: "/stacks/:id/settings (a substack)",
			expect: /Nested in/,
			name: "stacks-settings",
			path: () => `/stacks/${ids.subStack}/settings`,
			prepare: async (page) => {
				await page
					.getByRole("heading", { exact: true, name: "Nested in" })
					.scrollIntoViewIfNeeded();
			},
		},
		{
			doc: "/stacks/:id (a substack)",
			expect: /Queue worker/,
			name: "stacks-substack",
			path: () => `/stacks/${ids.subStack}`,
		},
		{
			doc: "/stacks/:id (list view)",
			expect: /Each service lists what it connects to underneath/,
			name: "stacks-graph-list",
			path: (seeded) => `/stacks/${seeded.stackId}`,
		},
		{
			doc: "/stacks/:id (card view)",
			expect: /Each service lists what it connects to underneath/,
			name: "stacks-graph-cards",
			path: (seeded) => `/stacks/${seeded.stackId}`,
			prepare: async (page) => {
				await page.getByRole("button", { name: "Card view" }).click();
				await expect(
					page.getByText("Arrows point from a service to what it connects to."),
				).toBeVisible();
			},
		},
		{
			doc: "/templates/new",
			expect: /New Template/,
			name: "templates-new",
			path: () => "/templates/new",
		},
		{
			doc: "/templates/:id (WordPress)",
			expect: /Deploys alongside/,
			name: "templates-details",
			path: () => `/templates/${ids.template}`,
		},
		{
			doc: "/templates/new (Linked containers)",
			expect: /New Template/,
			name: "templates-linked-containers",
			path: () => "/templates/new",
			prepare: (page) => scrollToSection(page, "Linked containers"),
		},
		{
			doc: "/services/:id/settings (Type & icon)",
			expect: /Type & icon/,
			name: "templates-icons",
			path: (seeded) => `/services/${seeded.serviceIds.web}/settings`,
			prepare: (page) => scrollToSection(page, "Type & icon"),
		},
		{
			doc: "/remote-hosts (Add a server, command generated)",
			expect: /Remote Hosts/,
			name: "remote-hosts-enroll-command",
			path: () => "/remote-hosts",
			prepare: async (page) => {
				await page.getByRole("button", { name: "Add a server" }).click();
				await page.getByRole("button", { name: "Generate command" }).click();
				await expect(
					page.getByText("Run this as root on the server."),
				).toBeVisible();
				await waitOutToast(page, "Enrollment command ready.");
			},
		},
		{
			doc: "/remote-hosts/new (Homerun Agent)",
			expect: /Add a new remote host/,
			name: "remote-hosts-register-agent",
			path: () => "/remote-hosts/new",
			prepare: async (page) => {
				await page.getByRole("button", { name: /Homerun Agent/ }).click();
				await expect(page.getByText("Set up the agent")).toBeVisible();
			},
		},
		{
			doc: "/registry",
			expect: /Collect garbage/,
			name: "registry-images",
			path: () => "/registry",
		},
		{
			doc: "/registry/tokens (a token just created)",
			expect: /New token/,
			name: "registry-tokens",
			path: () => "/registry/tokens",
			prepare: async (page) => {
				await page.getByPlaceholder("ci-pipeline").fill("github-actions");
				await page.getByRole("button", { name: "Create token" }).click();
				await expect(page.getByText("github-actions is ready")).toBeVisible();
				await waitOutToast(page, "Token created.");
			},
		},
		{
			doc: "/registry/credentials",
			expect: /Stored credentials/,
			name: "registry-credentials",
			path: () => "/registry/credentials",
		},
		{
			doc: "/registry/settings",
			expect: /Require authentication/,
			name: "registry-settings",
			path: () => "/registry/settings",
		},
		{
			doc: "/terminal",
			expect: /Homerun's key/,
			name: "machine-terminals-setup",
			path: () => "/terminal",
		},
	],
};
