import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import {
  ALPHA_GATE_CSRF_COOKIE,
  ALPHA_GATE_SESSION_COOKIE,
  createAlphaGateServer,
  normalizeAlphaGateReturnTarget,
} from "./alpha-gate.mjs";

const PASSWORD = "a".repeat(48);
const FORWARDED_HEADERS = {
  "x-alpha-gate-client-ip": "203.0.113.10",
  "x-forwarded-host": "alpha.example.test",
  "x-forwarded-proto": "https",
};

test("accepts only bounded same-origin relative return targets", () => {
  assert.equal(
    normalizeAlphaGateReturnTarget("/zakazky?stav=otvorene"),
    "/zakazky?stav=otvorene",
  );
  for (const malicious of [
    "https://evil.example/",
    "//evil.example/",
    "/%2f/evil.example",
    "/\\evil.example",
    "/path\r\nX-Test: injected",
    "/_alpha-gate/logout",
    "%",
    "",
  ]) {
    assert.equal(normalizeAlphaGateReturnTarget(malicious), "/");
  }
});

test("establishes one secure gate session without exposing credentials", async (t) => {
  let currentTime = Date.UTC(2026, 8, 30, 8, 0, 0);
  const fixture = await startGate({
    now: () => currentTime,
    password: PASSWORD,
    sessionTtlSeconds: 120,
  });
  t.after(fixture.close);

  const anonymous = await fixture.request({
    headers: {
      ...FORWARDED_HEADERS,
      "x-original-uri": "/zakazky?stav=otvorene",
    },
    path: "/verify",
  });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers["www-authenticate"], undefined);
  assert.equal(
    anonymous.headers["x-alpha-gate-login"],
    "/_alpha-gate/login?return=%2Fzakazky%3Fstav%3Dotvorene",
  );

  const login = await openLogin(fixture, "/zakazky?stav=otvorene");
  const wrong = await submitLogin(fixture, login, {
    password: "wrong-password",
    username: "alpha",
  });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body, /Prihlásenie sa nepodarilo/u);
  assert.doesNotMatch(wrong.body, /wrong-password/u);
  assert.equal(findSetCookie(wrong, ALPHA_GATE_SESSION_COOKIE), undefined);

  const secondLogin = await openLogin(fixture, "/zakazky?stav=otvorene");
  const accepted = await submitLogin(fixture, secondLogin, {
    password: PASSWORD,
    username: "alpha",
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.location, "/zakazky?stav=otvorene");
  const sessionCookie = findSetCookie(accepted, ALPHA_GATE_SESSION_COOKIE);
  assert.ok(sessionCookie !== undefined);
  assert.match(
    sessionCookie,
    /; Path=\/; Max-Age=120; HttpOnly; Secure; SameSite=Lax$/u,
  );
  assert.doesNotMatch(sessionCookie, /Domain=/iu);
  assert.doesNotMatch(sessionCookie, new RegExp(PASSWORD, "u"));
  assert.doesNotMatch(cookieValue(sessionCookie), /alpha/iu);

  const sessionPair = cookiePair(sessionCookie);
  const verified = await fixture.request({
    headers: {
      ...FORWARDED_HEADERS,
      cookie: sessionPair,
      "x-original-uri": "/zakazky",
    },
    path: "/verify",
  });
  assert.equal(verified.status, 204);

  const tampered = await fixture.request({
    headers: {
      ...FORWARDED_HEADERS,
      cookie: `${ALPHA_GATE_SESSION_COOKIE}=tampered`,
      "x-original-uri": "/",
    },
    path: "/verify",
  });
  assert.equal(tampered.status, 401);

  currentTime += 121_000;
  const expired = await fixture.request({
    headers: {
      ...FORWARDED_HEADERS,
      cookie: sessionPair,
      "x-original-uri": "/",
    },
    path: "/verify",
  });
  assert.equal(expired.status, 401);
});

test("uses identical credential denial and bounds attempts by client", async (t) => {
  let currentTime = Date.UTC(2026, 8, 30, 8, 0, 0);
  const fixture = await startGate({
    now: () => currentTime,
    password: PASSWORD,
    rateLimitMaxAttempts: 2,
    rateLimitWindowSeconds: 60,
  });
  t.after(fixture.close);

  const wrongUsernameLogin = await openLogin(fixture, "/");
  const wrongUsername = await submitLogin(fixture, wrongUsernameLogin, {
    password: PASSWORD,
    username: "someone-else",
  });
  assert.equal(wrongUsername.status, 401);
  assert.match(wrongUsername.body, /Prihlásenie sa nepodarilo/u);

  const wrongPasswordLogin = await openLogin(fixture, "/");
  const wrongPassword = await submitLogin(fixture, wrongPasswordLogin, {
    password: "wrong-password",
    username: "alpha",
  });
  assert.equal(wrongPassword.status, 429);
  assert.match(wrongPassword.body, /Prihlásenie sa nepodarilo/u);

  const blockedLogin = await openLogin(fixture, "/");
  const blockedCorrect = await submitLogin(fixture, blockedLogin, {
    password: PASSWORD,
    username: "alpha",
  });
  assert.equal(blockedCorrect.status, 429);
  assert.equal(
    findSetCookie(blockedCorrect, ALPHA_GATE_SESSION_COOKIE),
    undefined,
  );

  currentTime += 61_000;
  const recoveredLogin = await openLogin(fixture, "/");
  const recovered = await submitLogin(fixture, recoveredLogin, {
    password: PASSWORD,
    username: "alpha",
  });
  assert.equal(recovered.status, 303);
});

test("requires same-origin CSRF and invalidates only the gate session on logout", async (t) => {
  const fixture = await startGate({ password: PASSWORD });
  t.after(fixture.close);

  const login = await openLogin(fixture, "/remeselnici");
  const crossSite = await fixture.request({
    body: formBody({
      csrf: login.csrf,
      password: PASSWORD,
      return: "/remeselnici",
      username: "alpha",
    }),
    headers: {
      ...FORWARDED_HEADERS,
      "content-type": "application/x-www-form-urlencoded",
      cookie: login.csrfPair,
      origin: "https://evil.example",
    },
    method: "POST",
    path: "/login",
  });
  assert.equal(crossSite.status, 403);

  const accepted = await submitLogin(fixture, login, {
    password: PASSWORD,
    username: "alpha",
  });
  const sessionCookie = findSetCookie(accepted, ALPHA_GATE_SESSION_COOKIE);
  assert.ok(sessionCookie !== undefined);
  const sessionPair = cookiePair(sessionCookie);

  const logoutPage = await fixture.request({
    headers: { ...FORWARDED_HEADERS, cookie: sessionPair },
    path: "/logout",
  });
  assert.equal(logoutPage.status, 200);
  const logoutCsrfCookie = findSetCookie(logoutPage, ALPHA_GATE_CSRF_COOKIE);
  assert.ok(logoutCsrfCookie !== undefined);
  const logoutCsrf = hiddenValue(logoutPage.body, "csrf");
  const portalCookie = "portal.sid=portal-session-remains-independent";
  const loggedOut = await fixture.request({
    body: formBody({ csrf: logoutCsrf }),
    headers: {
      ...FORWARDED_HEADERS,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${sessionPair}; ${cookiePair(logoutCsrfCookie)}; ${portalCookie}`,
      origin: "https://alpha.example.test",
    },
    method: "POST",
    path: "/logout",
  });
  assert.equal(loggedOut.status, 303);
  assert.equal(loggedOut.headers.location, "/_alpha-gate/login?return=%2F");
  const cleared = loggedOut.headers["set-cookie"] ?? [];
  assert.ok(
    cleared.some((value) => value.startsWith(`${ALPHA_GATE_SESSION_COOKIE}=`)),
  );
  assert.ok(cleared.every((value) => !value.startsWith("portal.sid=")));

  const replayed = await fixture.request({
    headers: {
      ...FORWARDED_HEADERS,
      cookie: `${sessionPair}; ${portalCookie}`,
      "x-original-uri": "/remeselnici",
    },
    path: "/verify",
  });
  assert.equal(replayed.status, 401);
});

test("does not accept or challenge with HTTP Basic authentication", async (t) => {
  const fixture = await startGate({ password: PASSWORD });
  t.after(fixture.close);
  const authorization = `Basic ${Buffer.from(`alpha:${PASSWORD}`, "utf8").toString("base64")}`;
  const rejected = await fixture.request({
    headers: {
      ...FORWARDED_HEADERS,
      authorization,
      "x-original-uri": "/",
    },
    path: "/verify",
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers["www-authenticate"], undefined);
});

async function startGate(options) {
  const server = createAlphaGateServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    request: (input) => request(`http://127.0.0.1:${address.port}`, input),
  };
}

async function openLogin(fixture, returnTarget) {
  const response = await fixture.request({
    headers: FORWARDED_HEADERS,
    path: `/login?return=${encodeURIComponent(returnTarget)}`,
  });
  assert.equal(response.status, 200);
  const csrfCookie = findSetCookie(response, ALPHA_GATE_CSRF_COOKIE);
  assert.ok(csrfCookie !== undefined);
  return {
    csrf: hiddenValue(response.body, "csrf"),
    csrfPair: cookiePair(csrfCookie),
    returnTarget,
  };
}

function submitLogin(fixture, login, { password, username }) {
  return fixture.request({
    body: formBody({
      csrf: login.csrf,
      password,
      return: login.returnTarget,
      username,
    }),
    headers: {
      ...FORWARDED_HEADERS,
      "content-type": "application/x-www-form-urlencoded",
      cookie: login.csrfPair,
      origin: "https://alpha.example.test",
    },
    method: "POST",
    path: "/login",
  });
}

function request(baseUrl, { body, headers = {}, method = "GET", path }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${baseUrl}${path}`,
      { headers, method },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

function findSetCookie(response, name) {
  return (response.headers["set-cookie"] ?? []).find((value) =>
    value.startsWith(`${name}=`),
  );
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

function cookieValue(setCookie) {
  return cookiePair(setCookie).split("=", 2)[1] ?? "";
}

function hiddenValue(html, name) {
  const match = new RegExp(`name="${name}" value="([^"]+)"`, "u").exec(html);
  assert.ok(match !== null);
  return match[1];
}
