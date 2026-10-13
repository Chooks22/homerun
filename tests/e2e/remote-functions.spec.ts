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
	.serial("remote functions", () => {
		test("the dashboard's host resources resolve client-side, past the skeleton", async ({
			page,
		}) => {
			await signIn(page);

			// The strip renders nothing but skeletons until the query resolves,
			// so any of its real text proves it got past them.
			const main = page.locator("main");
			for (const label of ["CPU", "RAM", "Disk"]) {
				await expect(
					main.locator("span.eyebrow").filter({ hasText: label }),
				).toBeVisible();
			}
			await expect(
				main.getByText(/^\d+(\.\d+)? \/ \d+(\.\d+)? GB$/),
			).toHaveCount(2);
		});

		test("the notification feed resolves on the notifications page", async ({
			page,
		}) => {
			await signIn(page);

			await page
				.getByRole("link", { exact: true, name: "Notifications" })
				.click();
			await expect(page).toHaveURL(/\/notifications$/);
			await expect(page.getByText("No notifications yet.")).toBeVisible();
		});

		test("a command mutation refreshes the feed with no page reload", async ({
			page,
		}) => {
			await signIn(page);

			await page.goto("/services/new");
			await page.locator("#name").fill("remote-fn-check");
			await page.locator("#image").fill("nginx");
			await page.getByRole("button", { name: "Next" }).click();
			await page.locator("#containerPort").fill("80");
			await page.getByRole("button", { name: "Next" }).click();
			await page.getByRole("button", { name: "Next" }).click();
			await page.getByRole("button", { name: "Next" }).click();
			await page.getByRole("button", { name: "Create service" }).click();
			await expect(page).toHaveURL(/\/services\/[0-9a-f-]{36}$/);

			await page.goto("/");
			await page
				.getByRole("link", { exact: true, name: "Notifications" })
				.click();
			const entry = page.getByText('"remote-fn-check" was created.');
			await expect(entry).toBeVisible();

			const markAllRead = page.getByRole("button", { name: "Mark all read" });
			await expect(markAllRead).toBeVisible();
			await markAllRead.click();
			await expect(markAllRead).toBeHidden();

			await page
				.getByRole("button", { name: "Delete notification" })
				.first()
				.click();
			await expect(entry).toBeHidden();
		});

		test("the job queue panel resolves on the scheduling page", async ({
			page,
		}) => {
			await signIn(page);

			await page.goto("/scheduling");
			await expect(
				page.getByRole("heading", { name: "Job queue" }),
			).toBeVisible();
			await expect(page.getByText("Nothing in the queue")).toBeVisible();
		});

		for (const { heading, name, path } of [
			{ heading: "Services", name: "the services list", path: "/services" },
			{
				heading: "Docker Cleanup",
				name: "Docker Cleanup",
				path: "/docker-cleanup",
			},
			{ heading: "System Logs", name: "System Logs", path: "/system-logs" },
		]) {
			test(`${name} renders before its Docker query resolves`, async ({
				page,
			}) => {
				await signIn(page);

				await page.goto(path);
				await expect(
					page.getByRole("heading", { name: heading }),
				).toBeVisible();
			});
		}

		test("the settings tabs render without their setup diagnostics", async ({
			page,
		}) => {
			await signIn(page);

			await page.goto("/settings/networking");
			await expect(page.getByLabel("ACME account email")).toBeVisible();
		});
	});
