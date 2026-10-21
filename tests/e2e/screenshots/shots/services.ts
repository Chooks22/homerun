import type { Locator, Page } from "@playwright/test";
import { expect } from "../../support/test";
import { postAction, type ShotModule } from "./types";

const created: Record<string, string> = {};

/** Scrolls the dashboard's main pane so `target` sits at its top edge, `offset` pixels below it. */
async function scrollToTop(target: Locator, offset = 16): Promise<void> {
	await target.first().evaluate((el, gap) => {
		el.scrollIntoView({ block: "start" });
		document.getElementById("main-content")?.scrollBy(0, -gap);
	}, offset);
}

/** Creates a never-deployed service through the REST API and returns its id. */
async function createService(
	page: Page,
	data: Record<string, unknown>,
): Promise<string> {
	const res = await page.request.post("/api/v1/services", { data });
	expect(res.ok(), `creating ${data.slug}: ${await res.text()}`).toBeTruthy();
	return (await res.json()).id;
}

/** Patches a service through the REST API, failing loudly when it's refused. */
async function patchService(
	page: Page,
	id: string,
	data: Record<string, unknown>,
): Promise<void> {
	const res = await page.request.patch(`/api/v1/services/${id}`, { data });
	expect(res.ok(), `updating ${id}: ${await res.text()}`).toBeTruthy();
}

export const shots: ShotModule = {
	setup: async (page, seeded) => {
		const revisions = await page.request.get(
			`/api/v1/services/${seeded.serviceIds.web}/revisions`,
		);
		expect(revisions.ok(), "listing web's revisions").toBeTruthy();
		created.webRevision =
			((await revisions.json()) as { id: string }[])[0]?.id ?? "";

		created.storefront = await createService(page, {
			autoDeployOnPush: true,
			buildSource: "git",
			containerPort: 3000,
			envVars: { NODE_ENV: "production" },
			gitRef: "main",
			gitUrl: "https://git.example.com/acme/storefront.git",
			name: "Storefront",
			slug: "storefront",
		});
		await patchService(page, created.storefront, {
			environmentName: "staging",
		});
		await postAction(
			page,
			`/services/${created.storefront}/environments/previews?/updatePreviews`,
			{
				previewBranchExclude: "dependabot/*\nrenovate/*",
				previewBranchInclude: "",
				previewCopyVolumes: "on",
				previewDefaultDomain: "on",
				previewDomainTemplate: "pr-{pr}.preview.example.com",
				previewEnvOverrides: "DATABASE_URL=postgres://app@db/app_pr_{pr}",
				previewInheritEnv: "on",
				previewsEnabled: "on",
			},
		);
		for (const [name, ref] of [
			["demo", "demo"],
			["dev", "develop"],
		]) {
			await postAction(
				page,
				`/services/${created.storefront}/environments?/createEnvironment`,
				{
					domain: name === "demo" ? "demo.storefront.example.com" : "",
					envOverrides: `DATABASE_URL=postgres://app@db/app_${name}`,
					name,
					ref,
				},
			);
		}

		created.handbook = await createService(page, {
			buildSource: "git",
			containerPort: 3000,
			gitRef: "main",
			gitUrl: "https://github.com/orochibraru/homerun.git",
			name: "Handbook",
			slug: "handbook",
		});
		await patchService(page, created.handbook, {
			requireStatusChecks: true,
			requiredStatusChecks: ["ci/build", "ci/test"],
		});

		await postAction(page, "/git-providers?/addProvider", {
			clientId: "homerun-acme",
			clientSecret: "not-a-real-secret",
			kind: "gitlab",
			name: "Acme GitLab",
		});
	},
	shots: [
		{
			doc: "/services/:id/settings",
			expect: /Service settings/,
			name: "services-settings",
			path: (seeded) => `/services/${seeded.serviceIds.web}/settings`,
		},
		{
			doc: "/services/:id/observability/health",
			expect: /Current healthcheck/,
			name: "services-health",
			path: (seeded) =>
				`/services/${seeded.serviceIds.web}/observability/health`,
		},
		{
			doc: "/services/:id/environments/source (git repository)",
			expect: /Repository URL/,
			name: "source-git",
			path: () => `/services/${created.storefront}/environments/source`,
		},
		{
			doc: "/services/:id/environments/source (build method picker open)",
			expect: /Repository URL/,
			name: "source-build-methods",
			path: () => `/services/${created.storefront}/environments/source`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label[for='gitBuildMethod']"));
				await page.locator("#gitBuildMethod").click();
				await expect(
					page.getByRole("option", { name: "Paketo buildpacks" }),
				).toBeVisible();
			},
		},
		{
			doc: "/services/:id/environments/source (build cache and build server)",
			expect: /Repository URL/,
			name: "source-build-servers",
			path: () => `/services/${created.storefront}/environments/source`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label[for='gitBuildContext']"));
			},
		},
		{
			doc: "/services/:id/environments/source (deploy on push)",
			expect: /Add a webhook in the repository's settings/,
			name: "deploy-on-push-webhook",
			path: () => `/services/${created.storefront}/environments/source`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label:has(#autoDeployOnPush)"));
			},
		},
		{
			doc: "/git-providers (Add provider)",
			expect: /Acme GitLab/,
			name: "git-providers",
			path: () => "/git-providers",
			prepare: async (page) => {
				await page.getByRole("button", { name: "Add provider" }).click();
				await expect(
					page.getByRole("button", { name: "Create GitHub App" }),
				).toBeVisible();
			},
		},
		{
			doc: "/services/:id/environments/previews",
			expect: /Enable pull request previews/,
			name: "previews-tab",
			path: () => `/services/${created.storefront}/environments/previews`,
		},
		{
			doc: "/services/:id/environments/previews (Open previews)",
			expect: /Enable pull request previews/,
			name: "previews-open",
			path: () => `/services/${created.storefront}/environments/previews`,
			prepare: async (page) => {
				await scrollToTop(
					page.locator("section.panel").filter({
						hasText: "Open pull requests with a preview, newest first.",
					}),
				);
			},
		},
		{
			doc: "/services/:id/environments/source (Report deployments to GitHub)",
			expect: /Repository URL/,
			name: "environments-github-report",
			path: () => `/services/${created.storefront}/environments/source`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label:has(#previewReportGithub)"), 360);
			},
		},
		{
			doc: "/services/:id/environments",
			expect: /New environment/,
			name: "environments-list",
			path: () => `/services/${created.storefront}/environments`,
		},
		{
			doc: "/services/:id/environments (New environment dialog)",
			expect: /New environment/,
			name: "environments-new",
			path: () => `/services/${created.storefront}/environments`,
			prepare: async (page) => {
				await page.getByRole("button", { name: "New environment" }).click();
				await page.getByRole("button", { exact: true, name: "test" }).click();
				await expect(page.locator("#environmentName")).toHaveValue("test");
			},
		},
		{
			doc: "/services/:id/environments/previews (environment and data)",
			expect: /Enable pull request previews/,
			name: "previews-environment",
			path: () => `/services/${created.storefront}/environments/previews`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label:has(#previewInheritEnv)"));
			},
		},
		{
			doc: "/services/:id/environments/previews (branch filters)",
			expect: /Enable pull request previews/,
			name: "previews-branches",
			path: () => `/services/${created.storefront}/environments/previews`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label[for='previewBranchInclude']"));
			},
		},
		{
			doc: "/services/:id/environments/previews (Who can open previews)",
			expect: /Enable pull request previews/,
			name: "previews-access",
			path: () => `/services/${created.storefront}/environments/previews`,
			prepare: async (page) => {
				await page.locator("#authRequired").click();
				await page.locator("#method-password").click();
				await page.locator("#authAllowedEmails").fill("client@example.com");
				await scrollToTop(
					page.locator("section.panel:has(#login-wall-previews)"),
				);
			},
		},
		{
			doc: "/services/:id/environments/previews (domain template)",
			expect: /Enable pull request previews/,
			name: "previews-domains",
			path: () => `/services/${created.storefront}/environments/previews`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label[for='previewDomainTemplate']"));
			},
		},
		{
			doc: "/services/:id/environments/channels (Enable release channels ticked)",
			expect: /Enable release channels/,
			name: "release-channels-tab",
			path: () => `/services/${created.storefront}/environments/channels`,
			prepare: async (page) => {
				await page.locator("#channelsEnabled").click();
				await page.locator("#channelCanaryDomain").fill("canary.example.com");
			},
		},
		{
			doc: "/services/:id/settings (Environment)",
			expect: /Service settings/,
			name: "release-channels-environment",
			path: () => `/services/${created.storefront}/settings`,
			prepare: async (page) => {
				await scrollToTop(page.locator("label[for='pullPolicy']"));
			},
		},
		{
			doc: "/services/:id/settings (Auto-rollback)",
			expect: /Service settings/,
			name: "revisions-auto-rollback",
			path: (seeded) => `/services/${seeded.serviceIds.web}/settings`,
			prepare: async (page) => {
				await scrollToTop(page.locator("section.panel:has(#auto-rollback)"));
			},
		},
		{
			doc: "/services/:id/environments/revisions/:revisionId",
			expect: /All revisions/,
			name: "revisions-detail",
			path: (seeded) =>
				`/services/${seeded.serviceIds.web}/environments/revisions/${created.webRevision}`,
		},
		{
			doc: "/settings/docker (Retained images)",
			expect: /Retained images/,
			name: "revisions-retained-images",
			path: () => "/settings/docker",
			prepare: async (page) => {
				await scrollToTop(page.locator("section.panel:has(#retained-images)"));
			},
		},
		{
			doc: "/services/:id/environments/source (status checks)",
			expect: /Require status checks to pass before building/,
			name: "status-checks-picker",
			path: () => `/services/${created.handbook}/environments/source`,
			prepare: async (page) => {
				const checks = page.locator(
					"label:has(span.font-mono) [data-slot='checkbox']",
				);
				await expect(
					checks
						.first()
						.or(page.getByText(/No checks have reported|Couldn't read checks/))
						.first(),
				).toBeVisible({ timeout: 20_000 });
				const count = await checks.count();
				if (count > 0) {
					await checks.first().click();
				}
				if (count > 1) {
					await checks.nth(1).click();
				}
				await scrollToTop(page.getByText("Status checks", { exact: true }), 32);
			},
		},
		{
			doc: "/services/:id/security (Image scan)",
			expect: /Every deploy scans the image with Trivy/,
			name: "image-scanning-security",
			path: (seeded) => `/services/${seeded.serviceIds.web}/security`,
			prepare: async (page) => {
				await scrollToTop(
					page
						.locator("section.panel")
						.filter({ hasText: "Every deploy scans the image with Trivy" }),
				);
			},
		},
		{
			doc: "/services/:id/settings (Image scanning)",
			expect: /Service settings/,
			name: "image-scanning-service",
			path: (seeded) => `/services/${seeded.serviceIds.web}/settings`,
			prepare: async (page) => {
				await scrollToTop(page.locator("section.panel:has(#image-scan)"));
			},
		},
		{
			doc: "/settings/docker (Image scanning, High and above picked)",
			expect: /Block deploys at severity/,
			name: "image-scanning-settings",
			path: () => "/settings/docker",
			prepare: async (page) => {
				await scrollToTop(page.locator("section.panel:has(#image-scanning)"));
				await page.locator("#imageScanBlockSeverity").click();
				await page.getByRole("option", { name: "High and above" }).click();
				await expect(page.locator("#imageScanBlockSeverity")).toHaveText(
					/High and above/,
				);
			},
		},
	],
};
