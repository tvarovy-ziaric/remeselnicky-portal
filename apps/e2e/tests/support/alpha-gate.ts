import { expect, type BrowserContext, type Page } from "@playwright/test";

export const ALPHA_GATE_SESSION_COOKIE = "__Host-remeselnicky_alpha_gate";

export async function enterAlphaGate(
  page: Page,
  returnTo = "/",
): Promise<void> {
  const password = process.env.STAGING_E2E_ALPHA_GATE_PASSWORD;
  if (password === undefined) return;

  await page.goto(`/_alpha-gate/login?return=${encodeURIComponent(returnTo)}`);
  if (!new URL(page.url()).pathname.startsWith("/_alpha-gate/login")) return;

  await page.getByLabel("Používateľ").fill("alpha");
  await page.getByLabel("Heslo").fill(password);
  await page
    .getByRole("button", { name: "Vstúpiť do testovacej verzie" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(returnTo)}$`, "u"));
}

export async function enterAlphaGateContext(
  context: BrowserContext,
  returnTo = "/",
): Promise<void> {
  const page = await context.newPage();
  try {
    await enterAlphaGate(page, returnTo);
  } finally {
    await page.close();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
