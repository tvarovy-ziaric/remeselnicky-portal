import { expect, test } from "@playwright/test";

import { enterAlphaGate } from "./support/alpha-gate.js";

test.skip(
  process.env.STAGING_E2E_ENABLED !== "true",
  "R3-022 public staging origin is not provisioned",
);

test("an unauthenticated customer can reach sign-in from the request form", async ({
  page,
}) => {
  await enterAlphaGate(page, "/dopyt");
  const response = await page.goto("/dopyt");
  expect(response?.status()).toBe(200);

  await expect(
    page.getByRole("heading", { name: "Najprv sa prihláste" }),
  ).toBeVisible();
  const signIn = page
    .locator("#main-content")
    .getByRole("link", { name: "Prihlásiť sa" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("href", "/prihlasenie");

  await signIn.click();
  await expect(page).toHaveURL(/\/prihlasenie$/u);
  await expect(
    page.getByRole("heading", { name: "Vitajte späť" }),
  ).toBeVisible();
});
