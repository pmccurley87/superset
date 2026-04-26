import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	timeout: 30_000,
	retries: 0,
	use: {
		baseURL: "http://localhost:5199",
		headless: true,
	},
	webServer: {
		command: "bun run dev",
		url: "http://localhost:5199",
		reuseExistingServer: true,
		timeout: 30_000,
	},
});
