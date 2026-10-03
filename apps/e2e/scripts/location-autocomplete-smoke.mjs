import { readFile } from "node:fs/promises";

import { chromium, expect } from "@playwright/test";

import { ensureAlphaGateSession } from "./alpha-gate-session.mjs";

const environment = await readFile(
  new URL("../../../.env.alpha", import.meta.url),
  "utf8",
);
const hostname = /^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)$/mu.exec(
  environment,
)?.[1];
if (hostname === undefined) throw new Error("Quick app hostname is missing");
const origin = `https://${hostname}`;

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
  const context = await browser.newContext({ baseURL: origin });
  await ensureAlphaGateSession({
    baseURL: origin,
    context,
    password,
    returnTo: "/remeselnici",
  });
  const page = await context.newPage();
  const response = await page.goto(`${origin}/remeselnici`);
  expect(response?.status()).toBe(200);

  const location = page.getByRole("combobox", { name: "Obec alebo PSČ" });
  await expect(location).toBeVisible();

  await location.fill("Košice");
  const wholeKosice = page.getByRole("option", {
    name: /Košice · celé mesto · Košický kraj/u,
  });
  await expect(wholeKosice).toBeVisible();
  await expect(wholeKosice).not.toContainText(/PSČ|okres/u);

  await location.fill("Bratislava");
  const wholeBratislava = page.getByRole("option", {
    name: /Bratislava · celé mesto · Bratislavský kraj/u,
  });
  await expect(wholeBratislava).toBeVisible();
  await expect(wholeBratislava).not.toContainText(/PSČ|okres/u);
  await wholeBratislava.click();
  await expect(page.locator('input[name="municipalityCode"]')).toHaveValue(
    "582000",
  );
  await expect(location).toHaveValue("Bratislava");

  await location.fill("Prievidza");
  await expect(
    page.getByRole("option", { name: /Prievidza · 971 01/u }),
  ).toBeVisible();
  await location.press("ArrowDown");
  await expect(
    page.getByRole("option", { name: /971 01 · okres Prievidza/u }),
  ).toHaveAttribute("aria-selected", "true");
  await location.press("Enter");
  await expect(page.locator('input[name="municipalityCode"]')).toHaveValue(
    "513881",
  );
  await expect(location).toHaveValue("Prievidza");

  await location.fill("971 01");
  await expect(page.locator('input[name="municipalityCode"]')).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: /Prievidza · 971 01/u }),
  ).toBeVisible();
  await page.getByRole("option", { name: /Prievidza · 971 01/u }).click();
  await expect(page.locator('input[name="municipalityCode"]')).toHaveValue(
    "513881",
  );
  await expect(page.getByText("Vybraná lokalita: Prievidza")).toBeVisible();

  process.stdout.write(
    "Local Alpha whole-city, municipality and postal-code browser smoke passed.\n",
  );
} finally {
  await browser.close();
}
