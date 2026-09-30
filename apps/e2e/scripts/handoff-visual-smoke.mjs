import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, expect } from "@playwright/test";

import { ensureAlphaGateSession } from "./alpha-gate-session.mjs";

const root = new URL("../../../", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL(".alpha/r3-e2e-fixture.json", root), "utf8"),
);
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u.test(fixture.baseURL)) {
  throw new Error("Unexpected Quick Tunnel origin");
}

const password = (
  await readFile(new URL(".alpha/secrets/quick_gate_password", root), "utf8")
).trim();
const output = new URL(".alpha/design-compare/", root);
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const desktopPublic = await browser.newContext({
    baseURL: fixture.baseURL,
    viewport: { height: 900, width: 1440 },
  });
  await ensureAlphaGateSession({
    baseURL: fixture.baseURL,
    context: desktopPublic,
    password,
  });
  const desktopPage = await desktopPublic.newPage();
  await capturePublicScreens(desktopPage, "desktop");

  const profileHref = await desktopPage
    .locator('a[href^="/remeselnici/"]')
    .first()
    .getAttribute("href");
  if (profileHref === null)
    throw new Error("No synthetic public profile found");
  await desktopPage.goto(profileHref);
  await expect(desktopPage.getByRole("heading", { level: 1 })).toBeVisible();
  await screenshot(desktopPage, "profile-desktop.png");
  await desktopPublic.close();

  const mobilePublic = await browser.newContext({
    baseURL: fixture.baseURL,
    viewport: { height: 844, width: 390 },
  });
  await ensureAlphaGateSession({
    baseURL: fixture.baseURL,
    context: mobilePublic,
    password,
  });
  const mobilePage = await mobilePublic.newPage();
  await capturePublicScreens(mobilePage, "mobile");
  await mobilePage.goto(profileHref);
  await expect(mobilePage.getByRole("heading", { level: 1 })).toBeVisible();
  await screenshot(mobilePage, "profile-mobile.png");
  await mobilePublic.close();

  for (const [label, viewport] of [
    ["desktop", { height: 900, width: 1440 }],
    ["mobile", { height: 844, width: 390 }],
  ]) {
    const authenticated = await browser.newContext({
      baseURL: fixture.baseURL,
      storageState: fileURLToPath(new URL(".alpha/r3-e2e-auth-104.json", root)),
      viewport,
    });
    await ensureAlphaGateSession({
      baseURL: fixture.baseURL,
      context: authenticated,
      password,
      returnTo: "/zakazky",
    });
    const page = await authenticated.newPage();
    await page.goto("/zakazky");
    const jobHref = await page
      .locator('a[href^="/zakazky/"]')
      .first()
      .getAttribute("href");
    if (jobHref === null) throw new Error("No synthetic job found");
    await page.goto(jobHref);
    await expect(page.getByText("Rýchle akcie", { exact: true })).toBeVisible();
    await screenshot(page, `job-${label}.png`);
    await authenticated.close();
  }

  process.stdout.write(
    `Handoff visual smoke passed: ${fixture.baseURL} (${fileURLToPath(output)})\n`,
  );
} finally {
  await browser.close();
}

async function capturePublicScreens(page, label) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Nájdite overeného remeselníka pre svoju zákazku",
    }),
  ).toBeVisible();
  await screenshot(page, `home-${label}.png`);

  await page.goto("/remeselnici?professionCode=PROF%3AALPHA_SYNTHETIC");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Nájdite remeselníka pre svoju prácu",
    }),
  ).toBeVisible();
  await expect(page.locator(".search-result-card").first()).toBeVisible();
  await screenshot(page, `search-${label}.png`);
}

async function screenshot(page, name) {
  await page.screenshot({
    animations: "disabled",
    path: fileURLToPath(new URL(name, output)),
  });
}
