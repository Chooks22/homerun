import process from "node:process";
import { type Page, type TestInfo } from "@playwright/test";
import { E2E_BASE_URL } from "../support/config";
import { expect, test } from "../support/test";
import {
	AUTH_STATE,
	docker,
	dockerQuiet,
	loadTemplates,
	probeThroughTraefik,
	type TemplateFile,
} from "./support";

const SKIP: Record<string, string> = {};

const DEPLOY_TIMEOUT_MS = 8 * 60_000;
const HEALTH_TIMEOUT_MS = 5 * 60_000;
const ROUTE_TIMEOUT_MS = 2 * 60_000;
const PULL_ATTEMPTS = 4;
const PULL_BACKOFF_MS = 15_000;
const RATE_LIMITED_BACKOFF_MS = 45_000;
const DEPLOY_RETRIES = 2;
const POLL_MS = 3000;
const SETTLED_DEPLOY = new Set(["running", "failed", "stopped", "missing"]);
const SETTLED_HEALTH = new Set(["healthy", "unhealthy", "rolled_back"]);

interface Service {
	id: string;
	image: string;
	name: string;
	slug: string;
	stackId: string | null;
	tag: string;
}

interface Deployed {
	pulled: string[];
	services: Service[];
	stackId: string | null;
}

const all = loadTemplates();
const bySlug = new Map(all.map((template) => [template.slug, template]));
const only = process.env.TEMPLATES_E2E_ONLY?.split(",")
	.map((slug) => slug.trim())
	.filter(Boolean);
const selected = only?.length
	? all.filter((template) => only.includes(template.slug))
	: all;

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Polls `probe` every few seconds until it returns a value, or returns null
 * once `timeoutMs` has passed.
 */
async function poll<T>(
	timeoutMs: number,
	probe: () => Promise<T | null>,
): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// oxlint-disable-next-line no-await-in-loop -- polling: each probe waits on the previous one
		const value = await probe();
		if (value !== null) {
			return value;
		}
		// oxlint-disable-next-line no-await-in-loop -- polling interval
		await sleep(POLL_MS);
	}
	return null;
}

/** The template and its linked companions' `image:tag` refs. */
function imagesOf(template: TemplateFile): string[] {
	const companions = (template.links ?? []).flatMap(
		(link) => bySlug.get(link.template) ?? [],
	);
	return [
		...new Set([template, ...companions].map((t) => `${t.image}:${t.tag}`)),
	];
}

/**
 * Pulls every image not already on the host, retrying a failed pull with a
 * growing pause (a longer one when the registry answers `toomanyrequests`),
 * so a registry hiccup or rate limit doesn't fail the template. Records each
 * ref it pulled in `pulled`, which cleanup may remove again.
 *
 * @throws Error when an image still can't be pulled after every attempt.
 */
async function prePull(images: string[], pulled: string[]): Promise<void> {
	for (const image of images) {
		// oxlint-disable-next-line no-await-in-loop -- one pull at a time keeps the runner's bandwidth for the image in flight
		if (await dockerQuiet(["image", "inspect", "--format", "{{.Id}}", image])) {
			continue;
		}
		for (let attempt = 1; ; attempt++) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- retrying the same pull
				await docker(["pull", "--quiet", image], 15 * 60_000);
				pulled.push(image);
				break;
			} catch (error) {
				if (attempt >= PULL_ATTEMPTS) {
					throw error;
				}
				const rateLimited = String(error).includes("toomanyrequests");
				// oxlint-disable-next-line no-await-in-loop -- backoff between attempts
				await sleep(
					attempt * (rateLimited ? RATE_LIMITED_BACKOFF_MS : PULL_BACKOFF_MS),
				);
			}
		}
	}
}

/**
 * Quick-deploys a built-in template through the templates gallery's own form
 * action, the path the Quick Deploy button takes: it creates the service,
 * its linked companions, their stack, generated secrets and default data
 * volumes, then enqueues the stack deploy.
 */
async function quickDeploy(
	page: Page,
	template: TemplateFile,
	deployed: Deployed,
): Promise<void> {
	const response = await page.request.post("/templates?/quickDeploy", {
		form: { templateId: `builtin-${template.slug}` },
		headers: { origin: E2E_BASE_URL, "x-sveltekit-action": "true" },
		timeout: 120_000,
	});
	const result = (await response.json()) as { location?: string; type: string };
	const target = result.location?.match(/\/(services|stacks)\/([^/?#]+)/);
	expect(
		target,
		`Quick Deploy answered ${JSON.stringify(result)}`,
	).toBeTruthy();
	const [, kind, id] = target as RegExpMatchArray;
	if (kind === "services") {
		const service = await page.request.get(`/api/v1/services/${id}`);
		deployed.services = [(await service.json()) as Service];
		return;
	}
	deployed.stackId = id;
	const listed = await page.request.get("/api/v1/services?perPage=100");
	const services = ((await listed.json()) as Service[]).filter(
		(service) => service.stackId === id,
	);
	const isPrimary = (service: Service) =>
		service.image === template.image && service.tag === template.tag;
	deployed.services = [
		...services.filter((service) => !isPrimary(service)),
		...services.filter(isPrimary),
	];
	expect(deployed.services.length, "services in the new stack").toBe(
		1 + (template.links?.length ?? 0),
	);
}

/** The service's newest deployment row once it has settled, or null on timeout. */
async function settledDeployment(
	page: Page,
	service: Service,
): Promise<{ errorMessage: string | null; status: string } | null> {
	return await poll(DEPLOY_TIMEOUT_MS, async () => {
		const response = await page.request.get(
			`/api/v1/services/${service.id}/deployments?limit=1`,
		);
		const [latest] = (await response.json()) as {
			errorMessage: string | null;
			status: string;
		}[];
		return latest && SETTLED_DEPLOY.has(latest.status) ? latest : null;
	});
}

/**
 * Waits for each service's queued deploy, companions first, and redeploys one
 * that failed with the image the test already pulled (`pullPolicy: missing`)
 * up to twice. Once a companion needed a redeploy the primary's queued job was
 * cancelled with the chain, so it's redeployed directly.
 *
 * @throws Error naming the service and its last deploy error when it never
 *   reaches running.
 */
async function waitForDeploys(
	page: Page,
	deployed: Deployed,
	testInfo: TestInfo,
): Promise<void> {
	let chainBroken = false;
	for (const service of deployed.services) {
		// oxlint-disable-next-line no-await-in-loop -- companions deploy before the primary, in order
		const first = chainBroken ? null : await settledDeployment(page, service);
		let error = first?.errorMessage ?? (first ? first.status : "never settled");
		let ok = first?.status === "running";
		for (let retry = 1; !ok && retry <= DEPLOY_RETRIES; retry++) {
			chainBroken = true;
			testInfo.annotations.push({
				description: `${service.slug}: redeploy ${retry} after "${error}"`,
				type: "retry",
			});
			// oxlint-disable-next-line no-await-in-loop -- sequential retries
			await page.request.patch(`/api/v1/services/${service.id}`, {
				data: { pullPolicy: "missing" },
			});
			// oxlint-disable-next-line no-await-in-loop -- sequential retries
			const response = await page.request.post(
				`/api/v1/services/${service.id}/deploy`,
				{ timeout: DEPLOY_TIMEOUT_MS },
			);
			ok = response.ok();
			// oxlint-disable-next-line no-await-in-loop -- sequential retries
			error = ok ? "" : await response.text();
		}
		expect(ok, `${service.slug} never deployed: ${error}`).toBe(true);
	}
}

/**
 * Waits for the current revision of every service to get a health verdict
 * from the app's own health watch.
 *
 * @throws Error with the verdict's reason when one isn't healthy.
 */
async function waitForHealth(page: Page, deployed: Deployed): Promise<void> {
	await Promise.all(
		deployed.services.map(async (service) => {
			const verdict = await poll(HEALTH_TIMEOUT_MS, async () => {
				const response = await page.request.get(
					`/api/v1/services/${service.id}/revisions`,
				);
				const current = (
					(await response.json()) as {
						current: boolean;
						health: string | null;
						healthReason: string | null;
					}[]
				).find((revision) => revision.current);
				return current?.health && SETTLED_HEALTH.has(current.health)
					? current
					: null;
			});
			expect(
				verdict?.health,
				`${service.slug} health: ${verdict?.healthReason ?? "no verdict in time"}`,
			).toBe("healthy");
		}),
	);
}

/** The Docker container ids Homerun runs for these services. */
async function containersOf(services: Service[]): Promise<string[]> {
	const lists = await Promise.all(
		services.map((service) =>
			dockerQuiet([
				"ps",
				"-aq",
				"--filter",
				`label=homerun.service.id=${service.id}`,
			]),
		),
	);
	return lists.flatMap((list) => list?.split("\n").filter(Boolean) ?? []);
}

/** Every `Host(...)` hostname the container's Traefik router labels route. */
async function routedHostnames(container: string): Promise<string[]> {
	const raw = await dockerQuiet([
		"inspect",
		"--format",
		"{{json .Config.Labels}}",
		container,
	]);
	const labels = raw ? (JSON.parse(raw) as Record<string, string>) : {};
	if (labels["traefik.enable"] !== "true") {
		return [];
	}
	return Object.entries(labels)
		.filter(([key]) => /^traefik\.http\.routers\.[^.]+\.rule$/.test(key))
		.flatMap(([, rule]) =>
			[...rule.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1]),
		);
}

/**
 * Checks each routed service answers through Traefik: anything but a 5xx or
 * Traefik's own "no router" 404 counts, since a fresh app may answer with a
 * redirect to its setup page or a login.
 *
 * @returns One `hostname -> status` line per routed service.
 */
async function checkRoutes(deployed: Deployed): Promise<string[]> {
	const lines: string[] = [];
	for (const container of await containersOf(deployed.services)) {
		// oxlint-disable-next-line no-await-in-loop -- one route at a time, each already bounded
		const [hostname] = await routedHostnames(container);
		if (!hostname) {
			continue;
		}
		let last = "no answer";
		// oxlint-disable-next-line no-await-in-loop -- one route at a time
		const answered = await poll(ROUTE_TIMEOUT_MS, async () => {
			try {
				const { body, status } = await probeThroughTraefik(hostname);
				last = `${status} ${body.slice(0, 80).trim()}`;
				const traefikMiss =
					status === 404 && body.trim() === "404 page not found";
				return status < 500 && !traefikMiss ? status : null;
			} catch (error) {
				last = String(error);
				return null;
			}
		});
		expect(
			answered,
			`https://${hostname} through Traefik: ${last}`,
		).not.toBeNull();
		lines.push(`${hostname} -> ${answered}`);
	}
	return lines;
}

/** Attaches the last lines of each service container's log to the test, for a failure's report. */
async function attachLogs(
	deployed: Deployed,
	testInfo: TestInfo,
): Promise<void> {
	for (const container of await containersOf(deployed.services)) {
		// oxlint-disable-next-line no-await-in-loop -- one log at a time
		const logs = await dockerQuiet(["logs", "--tail", "150", container]);
		// oxlint-disable-next-line no-await-in-loop -- one attachment at a time
		await testInfo.attach(`container-${container}.log`, {
			body: logs ?? "(no logs)",
			contentType: "text/plain",
		});
	}
}

/**
 * Removes everything the template left: its stack (or lone service) through
 * the app, then any container the app couldn't remove, the containers'
 * volumes and, in CI, the images this test pulled, so the next template
 * starts on a clean host.
 */
async function cleanUp(page: Page, deployed: Deployed): Promise<void> {
	const containers = await containersOf(deployed.services);
	const mounts = containers.length
		? await dockerQuiet([
				"inspect",
				"--format",
				'{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}',
				...containers,
			])
		: null;
	if (deployed.stackId) {
		await page.request.post(`/stacks/${deployed.stackId}/settings?/delete`, {
			form: { force: "true" },
			headers: { origin: E2E_BASE_URL, "x-sveltekit-action": "true" },
			timeout: 180_000,
		});
	} else {
		for (const service of deployed.services) {
			// oxlint-disable-next-line no-await-in-loop -- one removal at a time
			await page.request.delete(`/api/v1/services/${service.id}?force=true`, {
				timeout: 180_000,
			});
		}
	}
	const leftovers = await containersOf(deployed.services);
	if (leftovers.length) {
		await dockerQuiet(["rm", "-f", "-v", ...leftovers]);
	}
	const volumes = mounts?.split(/\s+/).filter(Boolean) ?? [];
	if (volumes.length) {
		await dockerQuiet(["volume", "rm", "-f", ...volumes]);
	}
	if (process.env.CI && deployed.pulled.length) {
		await dockerQuiet(["image", "rm", ...deployed.pulled]);
	}
}

const CLEANUP_TIMEOUT_MS = 5 * 60_000;
let deployed: Deployed = { pulled: [], services: [], stackId: null };

test.describe.configure({ mode: "parallel" });
test.use({ storageState: AUTH_STATE });

test.afterEach(async ({ page }, testInfo) => {
	testInfo.setTimeout(testInfo.timeout + CLEANUP_TIMEOUT_MS);
	if (testInfo.status !== testInfo.expectedStatus) {
		await attachLogs(deployed, testInfo);
	}
	await cleanUp(page, deployed);
	deployed = { pulled: [], services: [], stackId: null };
});

for (const template of selected) {
	test(`${template.slug} (${template.image}:${template.tag})`, async ({
		page,
	}, testInfo) => {
		test.skip(template.slug in SKIP, SKIP[template.slug]);
		const started = Date.now();
		await prePull(imagesOf(template), deployed.pulled);
		await quickDeploy(page, template, deployed);
		await waitForDeploys(page, deployed, testInfo);
		await waitForHealth(page, deployed);
		const routes = await checkRoutes(deployed);
		testInfo.annotations.push({
			description: [
				`${deployed.services.length} service(s) healthy`,
				routes.length ? routes.join(", ") : "not routed",
				`${Math.round((Date.now() - started) / 1000)}s`,
			].join(" · "),
			type: "result",
		});
	});
}
