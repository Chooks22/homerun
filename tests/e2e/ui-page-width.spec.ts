import { type Page } from "@playwright/test";
import { expect, test } from "./support/test";

const WIDTHS = [1440, 1280, 1024, 900, 768, 640, 390];

const TABS = [
	"",
	"/environments",
	"/environments/source",
	"/environments/revisions",
	"/observability",
	"/observability/events",
	"/observability/errors",
	"/observability/errors/board",
	"/observability/traces",
	"/observability/pipelines",
	"/observability/health",
	"/volumes",
	"/networking",
	"/container",
	"/security",
	"/terminal",
	"/settings",
];

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

async function overflow(page: Page): Promise<string | null> {
	return await page.evaluate(() => {
		const main = document.querySelector<HTMLElement>("#main-content");
		if (!main || main.scrollWidth <= main.clientWidth) {
			return null;
		}
		const edge = main.getBoundingClientRect().right;
		const culprits = [...main.querySelectorAll<HTMLElement>("*")]
			.filter((el) => el.getBoundingClientRect().right > edge + 1)
			.filter(
				(el) =>
					!el.parentElement ||
					el.parentElement.getBoundingClientRect().right <= edge + 1,
			)
			.slice(0, 3)
			.map(
				(el) =>
					`<${el.tagName.toLowerCase()} class="${el.className}"> overshoots by ${Math.round(el.getBoundingClientRect().right - edge)}px`,
			);
		return `scrollWidth ${main.scrollWidth} > ${main.clientWidth}: ${culprits.join(" | ")}`;
	});
}

test("no service tab scrolls sideways", async ({ page }) => {
	test.setTimeout(240_000);
	await signIn(page);
	const id = await createService(page, "page-width");
	const problems: string[] = [];
	for (const width of WIDTHS) {
		await page.setViewportSize({ height: 900, width });
		for (const tab of TABS) {
			await page.goto(`/services/${id}${tab}`);
			await page.waitForLoadState("networkidle");
			const found = await overflow(page);
			if (found) {
				problems.push(`${width}px ${tab || "/"}: ${found}`);
			}
		}
	}
	expect(problems).toEqual([]);
});
