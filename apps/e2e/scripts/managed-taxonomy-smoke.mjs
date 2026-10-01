import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, expect } from "@playwright/test";

import { ensureAlphaGateSession } from "./alpha-gate-session.mjs";

const root = new URL("../../../", import.meta.url);
const environment = await readFile(new URL(".env.alpha", root), "utf8");
const hostname = /^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)$/mu.exec(
  environment,
)?.[1];
if (hostname === undefined) throw new Error("Quick app hostname is missing");
const baseURL = `https://${hostname}`;
const gatePassword = (
  await readFile(new URL(".alpha/secrets/quick_gate_password", root), "utf8")
).trim();

const fixture = JSON.parse(
  await readFile(new URL(".alpha/r3-e2e-fixture.json", root), "utf8"),
);
if (fixture.baseURL !== baseURL) {
  throw new Error("Synthetic fixture does not match the current Quick Tunnel");
}

const browser = await chromium.launch({ headless: true });
try {
  await customerSmoke();
  await craftsmanSmoke();
  process.stdout.write(
    `Managed taxonomy customer/craftsman browser smoke passed at ${baseURL}.\n`,
  );
} finally {
  await browser.close();
}

async function customerSmoke() {
  const context = await actorContext(101);
  try {
    const page = await context.newPage();
    const response = await page.goto("/dopyt");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Čo potrebujete urobiť?" }),
    ).toBeVisible();

    const autocomplete = page.getByRole("combobox", {
      name: "Profesia alebo služba",
    });
    await autocomplete.fill("elektrikar");
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeLessThanOrEqual(10);
    await expect(options.first()).toContainText("Profesia");
    await expect(options.first()).toContainText(/dostupn/u);
    await autocomplete.press("ArrowDown");
    await autocomplete.press("Enter");
    await expect(page.getByText(/Vybraná služba: Elektrikár/u)).toBeVisible();

    await autocomplete.fill("zasuvky");
    await expect(
      page.getByRole("option", { name: /Montáž zásuviek/u }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: /Montáž zásuviek/u }),
    ).toContainText("Služba");
    await page.getByRole("option", { name: /Montáž zásuviek/u }).click();
    await expect(
      page.getByText(/Vybraná služba: Montáž zásuviek/u),
    ).toBeVisible();
    await page.close();
  } finally {
    await context.close();
  }
}

async function craftsmanSmoke() {
  const context = await actorContext(102);
  try {
    const page = await context.newPage();
    const response = await page.goto("/ucet/profil-remeselnika");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Profesie a služby" }),
    ).toBeVisible();

    const autocomplete = page.getByRole("combobox", {
      name: "Profesia alebo služba",
    });
    await autocomplete.fill("elektrikar");
    await expect(
      page.getByRole("option", { name: /Elektrikár/u }),
    ).toBeVisible();
    expect(await page.getByRole("option").count()).toBeLessThanOrEqual(10);

    const nonce = randomUUID().replaceAll("-", "").slice(0, 10);
    const proposedName = `Syntetická katalógová skúška ${nonce}`;
    await autocomplete.fill(proposedName);
    await expect(
      page.getByText("Profesia ani služba sa nenašla."),
    ).toBeVisible();
    const trigger = page.getByRole("button", {
      name: "Navrhnúť chýbajúcu profesiu alebo službu",
    });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole("dialog", {
      name: "Navrhnite chýbajúcu položku",
    });
    await expect(dialog).toBeVisible();
    const name = dialog.getByLabel("Názov profesie alebo služby");
    await expect(name).toHaveValue(proposedName);
    await name.fill(`${proposedName} upravená`);
    await dialog
      .getByLabel("Krátky opis")
      .fill("Syntetický browser test spravovaného katalógu a admin kontroly.");
    await dialog.getByLabel("Typ (voliteľné)").selectOption("SERVICE");
    await dialog.getByRole("button", { name: "Odoslať návrh" }).click();
    await expect(page.getByText("Návrh sme prijali")).toBeVisible();
    await expect(
      page.getByText(/Návrh čaká na kontrolu administrátorom/u),
    ).toBeVisible();
    await page.close();
  } finally {
    await context.close();
  }
}

async function actorContext(number) {
  const context = await browser.newContext({
    baseURL,
    storageState: fileURLToPath(
      new URL(`.alpha/r3-e2e-auth-${number}.json`, root),
    ),
  });
  await ensureAlphaGateSession({ baseURL, context, password: gatePassword });
  return context;
}
