import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.STAGING_E2E_BASE_URL ?? "https://staging.invalid";

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "test-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  reporter: "line",
  retries: process.env.CI === "true" ? 1 : 0,
  testDir: "tests",
  timeout: 60_000,
  use: {
    baseURL,
    ignoreHTTPSErrors: false,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  workers: 1,
});
