import { expect, test, type Page } from "@playwright/test";

import { createSyntheticRegistrationFixture } from "./support/synthetic-registration.js";

test.skip(
  process.env["STAGING_E2E_CANONICAL_ENABLED"] !== "true",
  "Synthetic browser registration and the loopback verification sink are not provisioned",
);

test("a fresh user completes provider-neutral browser onboarding without exposing verification secrets", async ({
  browserName,
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(browserName !== "chromium", "One synthetic mutation is sufficient");

  const synthetic = await createSyntheticRegistrationFixture();
  const browserRequestUrls: string[] = [];
  page.on("request", (request) => browserRequestUrls.push(request.url()));

  await page.goto("/registracia");
  await expect(
    page.getByRole("heading", { level: 1, name: /Registrácia/u }),
  ).toBeVisible();
  await page.getByLabel(/^E-mail$/u).fill(synthetic.email);
  await page.getByLabel(/^Heslo$/u).fill(synthetic.password);
  await page
    .getByLabel(/^(?:Zopakujte heslo|Potvrdenie hesla)$/u)
    .fill(synthetic.password);
  await page.getByRole("checkbox", { name: /18 rokov/u }).check();
  await page.getByRole("button", { name: /^Vytvoriť účet$/u }).click();

  await expect(page).toHaveURL(/\/overenie$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: /^Overenie účtu$/u }),
  ).toBeVisible();
  await expect(page.getByText(/E-mail ešte nie je overený\./u)).toBeVisible();
  await expect(page.getByText(/Telefón ešte nie je overený\./u)).toBeVisible();

  const emailToken = await synthetic.claimEmailToken();
  await page.goto(`/overenie-emailu#token=${encodeURIComponent(emailToken)}`);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/overenie-emailu" && url.hash === "",
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /^Overenie e-mailu$/u }),
  ).toBeVisible();
  await expect(page.getByText(/^E-mail bol úspešne overený\.$/u)).toBeVisible();
  await expectSecretAbsent(page, emailToken);

  await page.goto(`/overenie-emailu#token=${encodeURIComponent(emailToken)}`);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/overenie-emailu" && url.hash === "",
  );
  await expect(
    page.getByText(/^Overovací odkaz je neplatný alebo už vypršal\.$/u),
  ).toBeVisible();
  await expectSecretAbsent(page, emailToken);

  await page.goto("/overenie");
  await expect(page.getByText(/^E-mail je overený\.$/u)).toBeVisible();
  await page.getByLabel(/^Telefónne číslo$/u).fill(synthetic.phone);
  await page.getByRole("button", { name: /^Poslať overovací kód$/u }).click();

  const phoneOtp = await synthetic.claimPhoneOtp();
  const invalidOtp = differentOtp(phoneOtp);
  const otpInput = page.getByLabel(/^(?:Šesťmiestny|Overovací) kód$/u);
  await otpInput.fill(invalidOtp);
  await page.getByRole("button", { name: /^Overiť telefón$/u }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /neplatný|vypršal/iu }),
  ).toBeVisible();

  await otpInput.fill(phoneOtp);
  await page.getByRole("button", { name: /^Overiť telefón$/u }).click();
  await expect(page.getByText(/^E-mail je overený\.$/u)).toBeVisible();
  await expect(page.getByText(/^Telefón je overený\.$/u)).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: /^Účet je pripravený$/u }),
  ).toBeVisible();
  await expectSecretAbsent(page, emailToken);
  await expectSecretAbsent(page, phoneOtp);

  expect(browserRequestUrls.some((url) => url.includes("/v1/claim"))).toBe(
    false,
  );
  expect(browserRequestUrls.some((url) => url.includes(emailToken))).toBe(
    false,
  );
  expect(browserRequestUrls.some((url) => url.includes(phoneOtp))).toBe(false);

  const requestCta = page.getByRole("link", {
    name: /Pokračovať.*(?:vytvorenie )?dopytu/iu,
  });
  await expect(requestCta).toHaveAttribute("href", "/dopyt");
  await requestCta.click();
  await expect(page).toHaveURL(/\/dopyt$/u);
});

async function expectSecretAbsent(page: Page, secret: string): Promise<void> {
  expect(page.url()).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);
}

function differentOtp(otp: string): string {
  const firstDigit = Number(otp[0]);
  return `${(firstDigit + 1) % 10}${otp.slice(1)}`;
}
