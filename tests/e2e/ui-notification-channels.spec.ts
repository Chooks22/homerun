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
	.serial("notification channels", () => {
		test("a webhook channel is added, subscribed, and removed", async ({
			page,
		}) => {
			await signIn(page);
			await page.goto("/notifications/settings");
			await page.getByRole("link", { exact: true, name: "Channels" }).click();
			await expect(page).toHaveURL(/\/notifications\/settings\/channels$/);
			await page
				.getByRole("link", { exact: true, name: "New channel" })
				.click();
			await expect(page).toHaveURL(/\/notifications\/settings\/channels\/new$/);

			await page.locator("#channelName").fill("E2E hook");
			await page.locator("#channelKind").click();
			await page.getByRole("option", { name: "Webhook" }).click();
			await page.locator("#channelTarget").fill("https://example.com/hook");
			await page.getByRole("button", { name: "Add channel" }).click();
			await expect(page.getByText("Channel added.")).toBeVisible();
			await expect(page).toHaveURL(/\/notifications\/settings\/channels$/);
			await expect(page.getByText("https://example.com/hook")).toBeVisible();
			await expect(
				page.getByText(
					"Build failed, Status checks failed, Update failed, Update available, Revision unhealthy, Rolled back",
				),
			).toBeVisible();

			await page.goto("/notifications/settings");
			const serviceDown = page.getByRole("checkbox", {
				name: "Service down to E2E hook",
			});
			await expect(serviceDown).not.toBeChecked();
			await expect(
				page.getByRole("checkbox", { name: "Build failed to E2E hook" }),
			).toBeChecked();
			const groupBursts = page.getByRole("checkbox", {
				name: "Group bursts to E2E hook",
			});
			await expect(groupBursts).not.toBeChecked();
			await serviceDown.click();
			await groupBursts.click();
			await page.getByRole("button", { name: "Save" }).click();
			await expect(
				page.getByText("Notification settings saved."),
			).toBeVisible();
			await page.reload();
			await expect(serviceDown).toBeChecked();
			await expect(groupBursts).toBeChecked();

			await page.goto("/notifications/settings/channels");
			await page.getByRole("button", { name: "Edit E2E hook" }).click();
			await page.locator("#editChannelName").fill("E2E hook renamed");
			await page
				.locator("#editChannelTarget")
				.fill("https://example.com/other-hook");
			await page.locator("#editChannelEnabled").click();
			await page.getByRole("button", { exact: true, name: "Save" }).click();
			await expect(page.getByText("Channel saved.")).toBeVisible();
			await expect(
				page.getByText("https://example.com/other-hook"),
			).toBeVisible();
			await expect(page.getByText("· Disabled")).toBeVisible();

			await page
				.getByRole("button", { name: "Remove E2E hook renamed" })
				.click();
			await page.getByRole("button", { exact: true, name: "Remove" }).click();
			await expect(page.getByText("Channel removed.")).toBeVisible();
			await expect(
				page.getByText("https://example.com/other-hook"),
			).toHaveCount(0);
		});

		test("a malformed Discord webhook URL is rejected", async ({ page }) => {
			await signIn(page);
			await page.goto("/notifications/settings/channels/new");

			await page.locator("#channelName").fill("Bad hook");
			await page.locator("#channelTarget").fill("https://example.com/hook");
			await page.getByRole("button", { name: "Add channel" }).click();

			await expect(
				page
					.locator("form")
					.filter({ has: page.locator("#channelName") })
					.getByText(/A Discord webhook URL looks like/),
			).toBeVisible();
		});

		test("a Telegram channel shows its chat but never its bot token", async ({
			page,
		}) => {
			await signIn(page);
			await page.goto("/notifications/settings/channels/new");

			const botToken = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
			await page.locator("#channelName").fill("E2E Telegram");
			await page.locator("#channelKind").click();
			await page.getByRole("option", { name: "Telegram" }).click();
			await expect(page.locator("#channelTarget")).toHaveCount(0);
			await page.locator("#telegramBotToken").fill(botToken);
			await page.locator("#telegramChatId").fill("-1001234567890");
			await page.getByRole("button", { name: "Add channel" }).click();
			await expect(page.getByText("Channel added.")).toBeVisible();
			await expect(page).toHaveURL(/\/notifications\/settings\/channels$/);
			await expect(page.getByText("Chat -1001234567890")).toBeVisible();
			await expect(page.getByText(botToken)).toHaveCount(0);

			await page.getByRole("button", { name: "Remove E2E Telegram" }).click();
			await page.getByRole("button", { exact: true, name: "Remove" }).click();
			await expect(page.getByText("Channel removed.")).toBeVisible();
		});

		test("a Slack channel needs a Slack webhook URL", async ({ page }) => {
			await signIn(page);
			await page.goto("/notifications/settings/channels/new");

			await page.locator("#channelName").fill("Bad Slack");
			await page.locator("#channelKind").click();
			await page.getByRole("option", { name: "Slack" }).click();
			await page.locator("#channelTarget").fill("https://example.com/hook");
			await page.getByRole("button", { name: "Add channel" }).click();

			await expect(
				page
					.locator("form")
					.filter({ has: page.locator("#channelName") })
					.getByText(/A Slack webhook URL looks like/),
			).toBeVisible();
		});
	});
