/**
 * E2E tests for the remote-control app.
 *
 * Run against the Linux desktop:
 *   RC_HOST=100.x.x.x RC_PORT=<port> RC_SECRET=<secret> bun run test:e2e
 *   Or via: ./e2e/run-live.sh
 */

import { test, expect, type Page } from "@playwright/test";

const HOST = process.env.RC_HOST ?? "127.0.0.1";
const PORT = process.env.RC_PORT ?? "44037";
const SECRET = process.env.RC_SECRET ?? "";

/** Navigate with credentials pre-filled via query params — triggers auto-fetch. */
async function goConnected(page: Page) {
	const params = `rc_host=${HOST}&rc_port=${PORT}&rc_secret=${SECRET}`;
	await page.goto(`/?${params}`);
	await expect(page.locator('[data-testid="status"]')).toContainText("session", {
		timeout: 10_000,
	});
}

test.describe("remote-control app", () => {
	test("renders config bar and sidebar on load", async ({ page }) => {
		await page.goto("/");
		await expect(page.locator('[data-testid="config-bar"]')).toBeVisible();
		await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
		await expect(page.locator('[data-testid="empty-state"]')).toBeVisible();
	});

	test("lists workspaces and sessions after connecting", async ({ page }) => {
		test.skip(!SECRET, "RC_SECRET not set — skipping live host tests");

		await goConnected(page);

		const sessionBtns = page.locator('[data-testid="session-btn"]');
		const newTermBtns = page.locator('[data-testid="new-term-btn"]');
		const count = (await sessionBtns.count()) + (await newTermBtns.count());
		expect(count).toBeGreaterThan(0);
	});

	test("opens a terminal tab when clicking a session", async ({ page }) => {
		test.skip(!SECRET, "RC_SECRET not set — skipping live host tests");

		await goConnected(page);

		const sessionBtn = page.locator('[data-testid="session-btn"]').first();
		await expect(sessionBtn).toBeVisible();
		await sessionBtn.click();

		await expect(page.locator('[data-testid="terminal-tabs"]')).toBeVisible();
		await expect(page.locator('[data-testid="tab"]')).toHaveCount(1);
		await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible();
		await expect(page.locator('[data-testid="empty-state"]')).not.toBeVisible();
	});

	test("closes a tab and returns to empty state", async ({ page }) => {
		test.skip(!SECRET, "RC_SECRET not set — skipping live host tests");

		await goConnected(page);

		await page.locator('[data-testid="session-btn"]').first().click();
		await expect(page.locator('[data-testid="tab"]')).toHaveCount(1);

		await page.click('[data-testid="tab-close"]');
		await expect(page.locator('[data-testid="tab"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="empty-state"]')).toBeVisible();
	});
});
