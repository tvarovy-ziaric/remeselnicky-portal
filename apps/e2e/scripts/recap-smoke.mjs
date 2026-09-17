import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, expect } from "@playwright/test";

const root = new URL("../../../", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL(".alpha/r3-e2e-fixture.json", root), "utf8"),
);
const password = (
  await readFile(new URL(".alpha/secrets/quick_gate_password", root), "utf8")
).trim();
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u.test(fixture.baseURL)) {
  throw new Error("Unexpected Quick Tunnel origin");
}
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    baseURL: fixture.baseURL,
    httpCredentials: { origin: fixture.baseURL, username: "alpha", password },
    storageState: fileURLToPath(new URL(".alpha/r3-e2e-auth-101.json", root)),
  });
  const page = await context.newPage();
  const comparison = await page.goto(`/ziadosti/${fixture.requestA}/ponuky`);
  expect(comparison?.status()).toBe(200);
  await page.getByRole("heading", { name: "Porovnanie ponúk" }).waitFor();
  await page.getByRole("link", { name: "Vybrať túto ponuku" }).first().click();
  await page
    .getByRole("heading", { name: "Rekapitulácia vybranej ponuky" })
    .waitFor();
  await expect(page.getByText("Záverečná kontrola")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Konečné potvrdenie/u }),
  ).toBeDisabled();
  await page.screenshot({
    path: fileURLToPath(new URL(".alpha/recap-smoke.png", root)),
    fullPage: true,
  });
  process.stdout.write("Synthetic R4 recap browser smoke passed.\n");
  await context.close();
} finally {
  await browser.close();
}
