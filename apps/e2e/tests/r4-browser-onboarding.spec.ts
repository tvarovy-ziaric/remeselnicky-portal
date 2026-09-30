import { expect, test, type Page } from "@playwright/test";

import { enterAlphaGate } from "./support/alpha-gate.js";
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
  page.setDefaultTimeout(10_000);

  const synthetic = await createSyntheticRegistrationFixture();
  const browserRequestUrls: string[] = [];
  page.on("request", (request) => browserRequestUrls.push(request.url()));

  await enterAlphaGate(page, "/registracia");
  await expect(
    page.getByRole("heading", { level: 1, name: "Vytvorte si účet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Prihlásiť sa" }).first(),
  ).toBeVisible();
  const registrationSubmit = page.getByRole("button", {
    name: /^Vytvoriť účet$/u,
  });
  await expect(registrationSubmit).toBeEnabled();
  await page.getByLabel(/^E-mail z pozvánky$/u).fill(synthetic.email);
  await page.locator("#registration-password").fill(synthetic.password);
  await page.locator("#registration-confirmation").fill(synthetic.password);
  const adultAttestation = page.getByRole("checkbox", { name: /18 rokov/u });
  await adultAttestation.check();
  await expect(adultAttestation).toBeChecked();
  await registrationSubmit.click();

  await expect(page).toHaveURL(/\/overenie$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /^Dokončite overenie účtu$/u,
    }),
  ).toBeVisible();
  await expect(page.getByText(/^Čaká na overenie$/u)).toHaveCount(2);

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
  await page.locator("#verification-phone").fill(synthetic.phone);
  await page.getByRole("button", { name: /^Poslať overovací kód$/u }).click();

  const phoneOtp = await synthetic.claimPhoneOtp();
  const invalidOtp = differentOtp(phoneOtp);
  const otpInput = page.locator("#verification-otp");
  await otpInput.fill(invalidOtp);
  await page.getByRole("button", { name: /^Overiť telefón$/u }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /neplatný|vypršal/iu }),
  ).toBeVisible();

  await otpInput.fill(phoneOtp);
  await page.getByRole("button", { name: /^Overiť telefón$/u }).click();
  await expect(page.getByText(/^E-mail je overený\.$/u)).toBeVisible();
  await expect(page.getByText(/^Telefón je overený\.$/u)).toBeVisible();
  await expect(page.getByText(/^Účet je pripravený$/u)).toBeVisible();
  await expectSecretAbsent(page, emailToken);
  await expectSecretAbsent(page, phoneOtp);

  expect(browserRequestUrls.some((url) => url.includes("/v1/claim"))).toBe(
    false,
  );
  expect(browserRequestUrls.some((url) => url.includes(emailToken))).toBe(
    false,
  );
  expect(browserRequestUrls.some((url) => url.includes(phoneOtp))).toBe(false);

  const accountCta = page.getByRole("link", {
    name: /Vybrať, ako pokračovať/iu,
  });
  await expect(accountCta).toHaveAttribute("href", "/ucet");
  await accountCta.click();
  await expect(page).toHaveURL(/\/ucet$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Kam chcete pokračovať?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Pokračovať ako zákazník" }),
  ).toHaveAttribute("href", "/dopyt");
  const craftsmanCta = page.getByRole("link", {
    name: "Pokračovať ako remeselník",
  });
  await expect(craftsmanCta).toHaveAttribute(
    "href",
    "/ucet/profil-remeselnika",
  );
  await expect(page.getByRole("link", { name: "Prihlásiť sa" })).toHaveCount(0);

  await craftsmanCta.click();
  await expect(page).toHaveURL(/\/ucet\/profil-remeselnika$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: /profil remeselníka/iu }),
  ).toBeVisible();
  const contextSwitch = page.getByRole("navigation", {
    name: "Prepnúť spôsob používania účtu",
  });
  await expect(
    contextSwitch.getByRole("link", { name: "Remeselník" }),
  ).toHaveAttribute("aria-current", "page");
  await contextSwitch.getByRole("link", { name: "Zákazník" }).click();
  await expect(page).toHaveURL(/\/dopyt$/u);
  await expect(page.getByRole("link", { name: "Prihlásiť sa" })).toHaveCount(0);

  await page.goto("/prihlasenie");
  await expect(page).toHaveURL(/\/ucet$/u);
});

async function expectSecretAbsent(page: Page, secret: string): Promise<void> {
  expect(page.url()).not.toContain(secret);
  expect(await page.content()).not.toContain(secret);
}

function differentOtp(otp: string): string {
  const firstDigit = Number(otp[0]);
  return `${(firstDigit + 1) % 10}${otp.slice(1)}`;
}
