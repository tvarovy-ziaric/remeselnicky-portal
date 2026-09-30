import { readFile } from "node:fs/promises";

import { chromium, expect } from "@playwright/test";

import { ALPHA_GATE_SESSION_COOKIE } from "./alpha-gate-session.mjs";

const environment = await readFile(
  new URL("../../../.env.alpha", import.meta.url),
  "utf8",
);
const hostname = /^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)$/mu.exec(
  environment,
)?.[1];
if (hostname === undefined) throw new Error("Quick app hostname is missing");
const baseURL = `https://${hostname}`;
const password = (
  await readFile(
    new URL("../../../.alpha/secrets/quick_gate_password", import.meta.url),
    "utf8",
  )
).trim();
if (!/^[0-9a-f]{48}$/u.test(password)) {
  throw new Error("Quick gate password is invalid");
}
const fixture = JSON.parse(
  await readFile(
    new URL("../../../.alpha/r3-e2e-fixture.json", import.meta.url),
    "utf8",
  ),
);
if (fixture.baseURL !== baseURL) {
  throw new Error("Synthetic fixture does not match the current Quick Tunnel");
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const browserErrors = [];
  const authResponses = [];
  const authenticatePosts = [];
  const challengedResponses = [];
  const anonymousApi = await context.request.get("/v1/auth/session");
  expect(anonymousApi.status()).toBe(401);
  expect(await anonymousApi.json()).toEqual({ code: "ALPHA_GATE_REQUIRED" });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/_alpha-gate/login"
    ) {
      authenticatePosts.push(request.url());
    }
  });
  context.on("response", (response) => {
    if (response.headers()["www-authenticate"] !== undefined) {
      challengedResponses.push({
        status: response.status(),
        url: response.url(),
      });
    }
    if (new URL(response.url()).pathname.startsWith("/v1/auth/")) {
      authResponses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
      });
    }
  });
  const returnTo = "/remeselnici?gateSmoke=session";
  await page.goto(returnTo);
  expect(new URL(page.url()).pathname).toBe("/_alpha-gate/login");
  expect(new URL(page.url()).searchParams.get("return")).toBe(returnTo);
  await expect(
    page.getByRole("heading", { name: "Testovacia Alpha" }),
  ).toBeVisible();
  await page.getByLabel("Používateľ").fill("alpha");
  await page.getByLabel("Heslo").fill(password);
  await page
    .getByRole("button", { name: "Vstúpiť do testovacej verzie" })
    .click();
  await page.waitForURL((url) => `${url.pathname}${url.search}` === returnTo);
  await page.getByLabel("Profesia alebo služba").waitFor();
  const gateCookie = (await context.cookies(baseURL)).find(
    (cookie) => cookie.name === ALPHA_GATE_SESSION_COOKIE,
  );
  expect(gateCookie).toMatchObject({
    domain: hostname,
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });
  expect(gateCookie.expires).toBeGreaterThan(Date.now() / 1_000 + 11 * 3_600);
  expect(gateCookie.value).not.toContain(password);
  expect((await context.request.get("/v1/auth/session")).status()).toBe(401);
  await page.reload();
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
  const profileLink = page.getByRole("link", {
    name: "Testovací remeselník Alfa",
  });
  await profileLink.first().click();
  await expect(
    page.getByRole("heading", { name: "Testovací remeselník Alfa" }),
  ).toBeVisible();
  await page.goto("/dopyt");
  await page.goBack();
  expect(new URL(page.url()).pathname).not.toBe("/_alpha-gate/login");
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Najprv sa prihláste" }),
  ).toBeVisible();
  const secondTab = await context.newPage();
  await secondTab.goto("/");
  expect(new URL(secondTab.url()).pathname).toBe("/");
  await secondTab.close();
  expect(authenticatePosts).toHaveLength(1);
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
  expect((await context.request.get("/v1/auth/session")).status()).toBe(200);

  const mediaResponse = await context.request.get(
    `/v1/media/${fixture.mediaA}/download`,
    { maxRedirects: 0 },
  );
  expect(mediaResponse.status()).toBe(303);
  const objectUrl = mediaResponse.headers().location;
  if (objectUrl === undefined)
    throw new Error("Signed object redirect is missing");
  expect(new URL(objectUrl).origin).not.toBe(baseURL);
  expect(
    (await context.cookies(objectUrl)).some(
      (cookie) => cookie.name === ALPHA_GATE_SESSION_COOKIE,
    ),
  ).toBe(false);
  const objectResponse = await context.request.get(objectUrl);
  expect(objectResponse.status()).toBe(200);
  expect(objectResponse.headers()["www-authenticate"]).toBeUndefined();

  const portalCookiesBeforeGateLogout = (await context.cookies(baseURL))
    .filter(
      (cookie) => !cookie.name.startsWith("__Host-remeselnicky_alpha_gate"),
    )
    .map(({ name, value }) => ({ name, value }))
    .sort((left, right) => left.name.localeCompare(right.name));
  expect(portalCookiesBeforeGateLogout.length).toBeGreaterThan(0);
  await page.goto("/_alpha-gate/logout");
  await page.getByRole("button", { name: "Opustiť testovaciu verziu" }).click();
  expect(new URL(page.url()).pathname).toBe("/_alpha-gate/login");
  expect(
    (await context.cookies(baseURL)).some(
      (cookie) => cookie.name === ALPHA_GATE_SESSION_COOKIE,
    ),
  ).toBe(false);
  const portalCookiesAfterGateLogout = (await context.cookies(baseURL))
    .filter(
      (cookie) => !cookie.name.startsWith("__Host-remeselnicky_alpha_gate"),
    )
    .map(({ name, value }) => ({ name, value }))
    .sort((left, right) => left.name.localeCompare(right.name));
  expect(portalCookiesAfterGateLogout).toEqual(portalCookiesBeforeGateLogout);

  const freshContext = await browser.newContext({ baseURL });
  const freshPage = await freshContext.newPage();
  await freshPage.goto("/");
  expect(new URL(freshPage.url()).pathname).toBe("/_alpha-gate/login");
  await freshContext.close();

  const tamperedContext = await browser.newContext({ baseURL });
  await tamperedContext.addCookies([
    {
      name: ALPHA_GATE_SESSION_COOKIE,
      url: baseURL,
      value: "tampered-session-token",
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
    },
  ]);
  const tamperedPage = await tamperedContext.newPage();
  await tamperedPage.goto("/");
  expect(new URL(tamperedPage.url()).pathname).toBe("/_alpha-gate/login");
  await tamperedContext.close();

  expect(challengedResponses).toEqual([]);
  expect(browserErrors).toEqual([]);
  process.stdout.write(
    "Quick Tunnel one-time Alpha gate, portal separation, and signed-media browser smoke passed.\n",
  );
  await context.close();
} finally {
  await browser.close();
}
