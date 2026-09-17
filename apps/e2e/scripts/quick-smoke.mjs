import { readFile } from "node:fs/promises";

import { chromium } from "@playwright/test";

const environment = await readFile(
  new URL("../../../.env.alpha", import.meta.url),
  "utf8",
);
const hostname = /^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)$/mu.exec(
  environment,
)?.[1];
if (hostname === undefined) throw new Error("Quick app hostname is missing");
const password = (
  await readFile(
    new URL("../../../.alpha/secrets/quick_gate_password", import.meta.url),
    "utf8",
  )
).trim();
if (!/^[0-9a-f]{48}$/u.test(password)) {
  throw new Error("Quick gate password is invalid");
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    httpCredentials: {
      origin: `https://${hostname}`,
      password,
      username: "alpha",
    },
  });
  const page = await context.newPage();
  const browserErrors = [];
  const authResponses = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/v1/auth/")) {
      authResponses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
    }
  });
  const response = await page.goto(`https://${hostname}/`);
  if (response?.status() !== 200) {
    throw new Error(`Quick app browser status ${response?.status()}`);
  }
  if ((await page.locator("h1").count()) !== 1) {
    throw new Error("Quick app heading is missing");
  }
  await page.goto(`https://${hostname}/remeselnici`);
  await page.getByLabel("Profesia alebo služba").waitFor();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Profesia alebo služba").fill("syntet");
  await page
    .getByRole("button", { name: "Syntetické testovacie remeslo" })
    .click();
  await page.getByRole("button", { name: "Hľadať remeselníkov" }).click();
  await page
    .getByRole("heading", { name: "Testovací remeselník Alfa" })
    .waitFor();
  await page.getByRole("heading", { name: "Syntetická dielňa Beta" }).waitFor();
  await page.goto(`https://${hostname}/dopyt`);
  await page.getByRole("link", { name: "Prihlásiť sa" }).click();
  await page.getByRole("heading", { name: "Prihlásenie" }).waitFor();
  await page.getByLabel("E-mail").waitFor();
  await page.getByLabel("Heslo").waitFor();
  await page.waitForLoadState("networkidle");
  const syntheticPassword = (
    await readFile(
      new URL(
        "../../../.alpha/secrets/synthetic_seed_password",
        import.meta.url,
      ),
      "utf8",
    )
  ).trim();
  await page.getByLabel("E-mail").fill("synthetic.account.101@portal.invalid");
  await page.getByLabel("Heslo").fill(syntheticPassword);
  await page.getByRole("button", { name: "Prihlásiť sa a pokračovať" }).click();
  try {
    await page
      .getByRole("heading", { name: "Čo potrebujete urobiť?" })
      .waitFor({ timeout: 10_000 });
  } catch (error) {
    const headings = await page.locator("h1").allTextContents();
    const alerts = await page.getByRole("alert").allTextContents();
    const validation = await page.locator("input").evaluateAll((inputs) =>
      inputs.map((input) => ({
        id: input.id,
        valid: input.validity.valid,
        validationMessage: input.validationMessage,
      })),
    );
    throw new Error(
      `Synthetic login did not reach draft form: ${JSON.stringify({ path: new URL(page.url()).pathname, headings, alerts, validation, authResponses, browserErrors })}`,
      { cause: error },
    );
  }
  process.stdout.write("Quick Tunnel Chromium browser smoke passed.\n");
} finally {
  await browser.close();
}
