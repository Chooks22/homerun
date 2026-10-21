import { expect, test } from "./support/test";

async function signIn(page: import("@playwright/test").Page) {
	await page.goto("/auth/sign-in");
	await page.locator("#email").fill("ada@example.com");
	await page.getByRole("button", { exact: true, name: "Continue" }).click();
	await page.locator("#password").fill("a-real-strong-password-123");
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4310\/$/);
}

test.describe
	.serial("the Registry page", () => {
		test.beforeEach(async ({ page }) => {
			await signIn(page);
		});

		test("is reachable from the sidebar and renders every tab", async ({
			page,
		}) => {
			await page
				.getByRole("button", { name: "Registries", exact: true })
				.first()
				.click();
			await page
				.getByRole("link", { name: "Docker Registry", exact: true })
				.click();
			await expect(page).toHaveURL(/\/registry$/);
			await expect(
				page.getByRole("heading", { level: 1, name: "Docker Registry" }),
			).toBeVisible();

			// The registry container isn't up in the E2E environment, so the
			// Images tab has to say so rather than fall over.
			await expect(
				page.getByText("The registry isn't answering."),
			).toBeVisible();
			await expect(page.getByText("Nothing in the registry yet")).toBeVisible();

			await page
				.locator(`[data-slot="tab-nav"] a[href="/registry/tokens"]`)
				.click();
			await expect(page).toHaveURL(/\/registry\/tokens$/);
			await expect(page.getByText("No tokens yet")).toBeVisible();

			await page
				.locator(`[data-slot="tab-nav"] a[href="/registry/credentials"]`)
				.click();
			await expect(page).toHaveURL(/\/registry\/credentials$/);
			await expect(
				page.getByRole("heading", { name: "Stored credentials" }),
			).toBeVisible();

			await page
				.locator(`[data-slot="tab-nav"] a[href="/registry/settings"]`)
				.click();
			await expect(page).toHaveURL(/\/registry\/settings$/);
			await expect(
				page.getByRole("heading", { name: "Require authentication" }),
			).toBeVisible();
		});

		test("refuses to publish the registry while auth is off", async ({
			page,
		}) => {
			await page.goto("/registry/settings");
			// The rule that keeps an open registry off the internet: the Save
			// button is disabled, and the server refuses it too (see
			// RegistryService.setPublicHost).
			await expect(
				page.getByText("Publishing is refused while the registry accepts"),
			).toBeVisible();
			await expect(
				page.locator("button[form='registry-public-host']"),
			).toBeDisabled();
		});

		test("creating a token shows its secret once, then lists it", async ({
			page,
		}) => {
			await page.goto("/registry/tokens");
			await page.locator('input[name="username"]').fill("ci-pipeline");
			await page.getByRole("button", { name: "Create token" }).click();

			await expect(page.getByText("ci-pipeline is ready")).toBeVisible();
			await expect(
				page.getByText("docker login", { exact: false }),
			).toBeVisible();

			// Reloading drops the one-time secret but keeps the token itself.
			await page.reload();
			await expect(page.getByText("ci-pipeline is ready")).toBeHidden();
			await expect(page.getByText("ci-pipeline")).toBeVisible();
		});
	});
