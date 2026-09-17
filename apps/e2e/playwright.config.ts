import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.STAGING_E2E_BASE_URL ?? "https://staging.invalid";
const accessClientId = process.env.STAGING_E2E_CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.STAGING_E2E_CF_ACCESS_CLIENT_SECRET;
const basicAuthUsername = process.env.STAGING_E2E_BASIC_AUTH_USERNAME;
const basicAuthPassword = process.env.STAGING_E2E_BASIC_AUTH_PASSWORD;
const firefoxExecutable = process.env.STAGING_E2E_FIREFOX_EXECUTABLE;

if ((accessClientId === undefined) !== (accessClientSecret === undefined)) {
  throw new Error(
    "Cloudflare Access E2E credentials must be supplied as an exact pair",
  );
}
if ((basicAuthUsername === undefined) !== (basicAuthPassword === undefined)) {
  throw new Error(
    "Temporary alpha Basic Auth credentials must be supplied as an exact pair",
  );
}
const extraHTTPHeaders =
  accessClientId === undefined || accessClientSecret === undefined
    ? undefined
    : {
        "CF-Access-Client-Id": accessClientId,
        "CF-Access-Client-Secret": accessClientSecret,
      };

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: "test-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        ...(firefoxExecutable === undefined
          ? {}
          : { launchOptions: { executablePath: firefoxExecutable } }),
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  reporter: "line",
  retries: process.env.CI === "true" ? 1 : 0,
  testDir: "tests",
  timeout: 60_000,
  use: {
    baseURL,
    ...(extraHTTPHeaders === undefined ? {} : { extraHTTPHeaders }),
    ...(basicAuthUsername === undefined || basicAuthPassword === undefined
      ? {}
      : {
          httpCredentials: {
            username: basicAuthUsername,
            password: basicAuthPassword,
            origin: baseURL,
          },
        }),
    ignoreHTTPSErrors: false,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  workers: 1,
});
