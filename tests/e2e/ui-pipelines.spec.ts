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

test.describe
	.serial("pipelines", () => {
		test("the sidebar's Observability section opens the Pipelines page", async ({
			page,
		}) => {
			await signIn(page);
			await page
				.getByRole("button", { exact: true, name: "Observability" })
				.click();
			await page.getByRole("link", { exact: true, name: "Pipelines" }).click();
			await expect(page).toHaveURL(/\/pipelines$/);
			await expect(
				page.getByRole("heading", { name: "Pipelines" }),
			).toBeVisible();
			await expect(page.getByText("No repository watched yet")).toBeVisible();
		});

		test("watching a repository asks for a connected git provider first", async ({
			page,
		}) => {
			await signIn(page);
			await page.goto("/pipelines");
			await page
				.getByRole("link", { name: "Watch repository" })
				.first()
				.click();
			await expect(page).toHaveURL(/\/pipelines\/new$/);
			await expect(page.getByText("No git provider connected")).toBeVisible();
			await expect(
				page.getByRole("link", { name: "Git Providers" }),
			).toBeVisible();
		});

		test("a service with no repository linked points to Pipelines", async ({
			page,
		}) => {
			await signIn(page);
			await page.goto("/services/new");
			await page.locator("#name").fill("pipelines-unlinked");
			await page.locator("#image").fill("nginx");
			await page.getByRole("button", { name: "Next" }).click();
			await page.locator("#containerPort").fill("80");
			await page.getByRole("button", { name: "Next" }).click();
			await page.getByRole("button", { name: "Next" }).click();
			await page.getByRole("button", { name: "Next" }).click();
			await page.getByRole("button", { name: "Create service" }).click();
			await expect(page).toHaveURL(/\/services\/[0-9a-f-]{36}$/);
			await page.goto(`${page.url()}/observability/pipelines`);
			await expect(page.getByText("No repository linked")).toBeVisible();
			await page.getByRole("link", { name: "Open Pipelines" }).click();
			await expect(page).toHaveURL(/\/pipelines$/);
		});
	});
