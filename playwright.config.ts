import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:48917", trace: "retain-on-failure", screenshot: "only-on-failure", serviceWorkers: "block" },
  projects: [
    { name: "desktop", use: { browserName: "chromium" } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: { command: "bun run e2e/server.ts", url: "http://127.0.0.1:48917/api/v1/health", reuseExistingServer: false, timeout: 30000 },
});
