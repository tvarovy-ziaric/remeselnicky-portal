import { expect, test } from "@playwright/test";

test.skip(
  process.env.STAGING_E2E_ENABLED !== "true",
  "R3-022 public staging origin is not provisioned",
);

test("an unauthenticated customer can reach sign-in from the request form", async ({
  baseURL,
  browserName,
  page,
}) => {
  if (
    browserName === "webkit" &&
    baseURL !== undefined &&
    process.env.STAGING_E2E_BASIC_AUTH_USERNAME !== undefined &&
    process.env.STAGING_E2E_BASIC_AUTH_PASSWORD !== undefined
  ) {
    const gateOrigin = new URL(baseURL).origin;
    const credential = Buffer.from(
      `${process.env.STAGING_E2E_BASIC_AUTH_USERNAME}:${process.env.STAGING_E2E_BASIC_AUTH_PASSWORD}`,
    ).toString("base64");
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== gateOrigin) {
        await route.continue();
        return;
      }
      await route.continue({
        headers: {
          ...route.request().headers(),
          authorization: `Basic ${credential}`,
        },
      });
    });
  }
  const response = await page.goto("/dopyt");
  expect(response?.status()).toBe(200);

  await expect(
    page.getByRole("heading", { name: "Najprv sa prihláste" }),
  ).toBeVisible();
  const signIn = page.getByRole("link", { name: "Prihlásiť sa" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("href", "/prihlasenie");

  await signIn.click();
  await expect(page).toHaveURL(/\/prihlasenie$/u);
  await expect(
    page.getByRole("heading", { name: "Prihlásenie" }),
  ).toBeVisible();
});
