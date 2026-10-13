import { type Page } from "@playwright/test";
import { expect, test } from "./support/test";

async function signIn(page: Page) {
	await page.goto("/auth/sign-in");
	await page.locator("#email").fill("ada@example.com");
	await page.getByRole("button", { exact: true, name: "Continue" }).click();
	await page.locator("#password").fill("a-real-strong-password-123");
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:4310\/$/);
}

async function createService(page: Page, name: string): Promise<string> {
	await page.goto("/services/new");
	await page.locator("#name").fill(name);
	await page.locator("#image").fill("nginx");
	await page.getByRole("button", { name: "Next" }).click();
	await page.locator("#containerPort").fill("80");
	await page.getByRole("button", { name: "Next" }).click();
	await page.getByRole("button", { name: "Next" }).click();
	await page.getByRole("button", { name: "Next" }).click();
	await page.getByRole("button", { name: "Create service" }).click();
	await expect(page).toHaveURL(/\/services\/[0-9a-f-]{36}$/);
	return page.url().split("/").pop() ?? "";
}

test.describe
	.serial("revisions and status checks", () => {
		test("auto-rollback is off by default and persists once turned on", async ({
			page,
		}) => {
			await signIn(page);
			const id = await createService(page, "rev-auto-rollback");

			await page.goto(`/services/${id}/settings`);
			const toggle = page.getByRole("checkbox", {
				name: /Auto-rollback when a new revision is unhealthy/,
			});
			await expect(toggle).not.toBeChecked();
			await toggle.click();
			await page.locator("button[form='auto-rollback']").click();
			await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
			await page.reload();
			await expect(
				page.getByRole("checkbox", {
					name: /Auto-rollback when a new revision is unhealthy/,
				}),
			).toBeChecked();

			await page.goto(`/services/${id}/environments/revisions`);
			await expect(page.getByText("No revisions yet")).toBeVisible();

			const missing = await page.goto(
				`/services/${id}/environments/revisions/not-a-revision`,
			);
			expect(missing?.status()).toBe(404);
		});

		test("requiring status checks without picking one is refused", async ({
			page,
		}) => {
			await signIn(page);
			const id = await createService(page, "rev-status-checks");

			await page.goto(`/services/${id}/environments/source`);
			await page.getByRole("button", { name: "Git repository" }).click();
			await page.locator("#gitUrl").fill("https://git.invalid/acme/api.git");
			await page
				.getByRole("checkbox", {
					name: /Require status checks to pass before building/,
				})
				.click();
			await expect(page.getByText("Required checks")).toBeVisible();
			await page.locator('button[form="source-settings"]').click();
			await expect(
				page
					.getByText("Pick at least one check to require", { exact: false })
					.first(),
			).toBeVisible();
			await page.mouse.move(0, 0);
			await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
				timeout: 15_000,
			});

			await page.getByLabel("Check name").fill("build");
			await page.getByRole("button", { exact: true, name: "Add" }).click();
			await page.locator('button[form="source-settings"]').click();
			await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
			await page.reload();
			await expect(
				page.getByRole("checkbox", {
					name: /Require status checks to pass before building/,
				}),
			).toBeChecked();
			await expect(page.getByText("build", { exact: true })).toBeVisible();
		});
	});
