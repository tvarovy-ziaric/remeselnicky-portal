import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const ALPHA_GATE_SESSION_COOKIE = "__Host-remeselnicky_alpha_gate";
export const ALPHA_GATE_CSRF_COOKIE = "__Host-remeselnicky_alpha_gate_csrf";
export const ALPHA_GATE_SESSION_TTL_SECONDS = 12 * 60 * 60;

const CSRF_TTL_SECONDS = 10 * 60;
const LOGIN_BODY_LIMIT = 4 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const MAX_RETURN_TARGET_LENGTH = 2_048;
const MAX_STATE_ENTRIES = 5_000;

export function normalizeAlphaGateReturnTarget(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RETURN_TARGET_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n\0]/u.test(value)
  ) {
    return "/";
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }
  if (
    decoded.startsWith("//") ||
    decoded.startsWith("/\\") ||
    /[\\\r\n\0]/u.test(decoded)
  ) {
    return "/";
  }
  let parsed;
  try {
    parsed = new URL(value, "https://alpha.invalid");
  } catch {
    return "/";
  }
  if (
    parsed.origin !== "https://alpha.invalid" ||
    parsed.pathname.startsWith("/_alpha-gate/")
  ) {
    return "/";
  }
  return `${parsed.pathname}${parsed.search}`;
}

export function createAlphaGateServer({
  password,
  now = () => Date.now(),
  sessionTtlSeconds = ALPHA_GATE_SESSION_TTL_SECONDS,
  rateLimitMaxAttempts = RATE_LIMIT_MAX_ATTEMPTS,
  rateLimitWindowSeconds = RATE_LIMIT_WINDOW_SECONDS,
} = {}) {
  if (typeof password !== "string" || !/^[0-9a-f]{48}$/u.test(password)) {
    throw new Error(
      "Alpha gate password must be the existing 48-character secret",
    );
  }
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60) {
    throw new Error("Alpha gate session lifetime is invalid");
  }

  const expectedUsername = digest("alpha");
  const expectedPassword = digest(password);
  const rateLimitKey = createHash("sha256")
    .update("remeselnicky-alpha-gate-rate-limit-v1\0", "utf8")
    .update(password, "utf8")
    .digest();
  const sessions = new Map();
  const csrfTokens = new Map();
  const failures = new Map();

  function cleanupState() {
    const current = now();
    removeExpired(sessions, current);
    removeExpired(csrfTokens, current);
    for (const [key, value] of failures) {
      if (value.resetAt <= current) failures.delete(key);
    }
    trimOldest(sessions);
    trimOldest(csrfTokens);
    trimOldest(failures);
  }

  function issueOpaqueToken(store, lifetimeSeconds) {
    cleanupState();
    const token = randomBytes(32).toString("base64url");
    store.set(tokenDigest(token), now() + lifetimeSeconds * 1_000);
    return token;
  }

  function tokenIsValid(store, token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      return false;
    }
    const key = tokenDigest(token);
    const expiresAt = store.get(key);
    if (expiresAt === undefined || expiresAt <= now()) {
      if (expiresAt !== undefined) store.delete(key);
      return false;
    }
    return true;
  }

  function consumeToken(store, token) {
    if (!tokenIsValid(store, token)) return false;
    store.delete(tokenDigest(token));
    return true;
  }

  function credentialsAreValid(username, candidatePassword) {
    return (
      safeDigestEqual(expectedUsername, digest(username)) &&
      safeDigestEqual(expectedPassword, digest(candidatePassword))
    );
  }

  function clientKey(request) {
    const address = firstHeader(request.headers["x-alpha-gate-client-ip"]);
    const bounded = (
      address ||
      request.socket.remoteAddress ||
      "unknown"
    ).slice(0, 128);
    return createHmac("sha256", rateLimitKey).update(bounded).digest("hex");
  }

  function isRateLimited(key) {
    const state = failures.get(key);
    return (
      state !== undefined &&
      state.resetAt > now() &&
      state.count >= rateLimitMaxAttempts
    );
  }

  function recordFailure(key) {
    cleanupState();
    const current = failures.get(key);
    if (current === undefined || current.resetAt <= now()) {
      failures.set(key, {
        count: 1,
        expiresAt: now() + rateLimitWindowSeconds * 1_000,
        resetAt: now() + rateLimitWindowSeconds * 1_000,
      });
      return;
    }
    failures.set(key, { ...current, count: current.count + 1 });
  }

  function clearFailures(key) {
    failures.delete(key);
  }

  function validSession(request) {
    const cookies = parseCookies(request.headers.cookie);
    return tokenIsValid(sessions, cookies.get(ALPHA_GATE_SESSION_COOKIE));
  }

  function expectedOrigin(request) {
    const host = firstHeader(request.headers["x-forwarded-host"]);
    const protocol = firstHeader(request.headers["x-forwarded-proto"]);
    if (
      host === "" ||
      protocol === "" ||
      !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/iu.test(host) ||
      !/^(?:http|https)$/u.test(protocol)
    ) {
      return null;
    }
    return `${protocol}://${host}`;
  }

  function sameOriginPost(request) {
    const origin = firstHeader(request.headers.origin);
    const expected = expectedOrigin(request);
    return expected !== null && origin === expected;
  }

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    const requestUrl = new URL(request.url ?? "/", "http://alpha-gate.invalid");

    if (request.method === "GET" && requestUrl.pathname === "/health/live") {
      sendText(response, 200, "ok");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/verify") {
      if (validSession(request)) {
        response.writeHead(204).end();
        return;
      }
      const returnTarget = normalizeAlphaGateReturnTarget(
        firstHeader(request.headers["x-original-uri"]),
      );
      response.setHeader(
        "x-alpha-gate-login",
        `/_alpha-gate/login?return=${encodeURIComponent(returnTarget)}`,
      );
      response.writeHead(401).end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/login") {
      const returnTarget = normalizeAlphaGateReturnTarget(
        requestUrl.searchParams.get("return"),
      );
      if (validSession(request)) {
        redirect(response, returnTarget);
        return;
      }
      renderLogin(response, { returnTarget, csrfTokens, now });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/login") {
      if (!sameOriginPost(request)) {
        sendText(response, 403, "Požiadavku sa nepodarilo overiť.");
        return;
      }
      const form = await readForm(request, response);
      if (form === null) return;
      const cookies = parseCookies(request.headers.cookie);
      const csrfCookie = cookies.get(ALPHA_GATE_CSRF_COOKIE);
      const csrfForm = form.get("csrf");
      if (
        !safeTextEqual(csrfCookie, csrfForm) ||
        !consumeToken(csrfTokens, csrfCookie)
      ) {
        sendText(response, 403, "Relácia formulára vypršala. Obnovte stránku.");
        return;
      }
      const returnTarget = normalizeAlphaGateReturnTarget(form.get("return"));
      const key = clientKey(request);
      const valid = credentialsAreValid(
        form.get("username") ?? "",
        form.get("password") ?? "",
      );
      if (!valid || isRateLimited(key)) {
        if (!valid) recordFailure(key);
        renderLogin(response, {
          error:
            "Prihlásenie sa nepodarilo. Skontrolujte údaje alebo to skúste neskôr.",
          returnTarget,
          csrfTokens,
          now,
          status: isRateLimited(key) ? 429 : 401,
        });
        return;
      }
      clearFailures(key);
      const session = issueOpaqueToken(sessions, sessionTtlSeconds);
      response.setHeader("set-cookie", [
        sessionCookie(session, sessionTtlSeconds),
        clearCookie(ALPHA_GATE_CSRF_COOKIE),
      ]);
      redirect(response, returnTarget);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/logout") {
      if (!validSession(request)) {
        redirect(response, "/_alpha-gate/login?return=%2F");
        return;
      }
      const csrf = issueOpaqueToken(csrfTokens, CSRF_TTL_SECONDS);
      response.setHeader("set-cookie", csrfCookie(csrf));
      sendHtml(response, 200, logoutPage(csrf));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/logout") {
      if (!sameOriginPost(request)) {
        sendText(response, 403, "Požiadavku sa nepodarilo overiť.");
        return;
      }
      const form = await readForm(request, response);
      if (form === null) return;
      const cookies = parseCookies(request.headers.cookie);
      const csrfCookieValue = cookies.get(ALPHA_GATE_CSRF_COOKIE);
      if (
        !safeTextEqual(csrfCookieValue, form.get("csrf")) ||
        !consumeToken(csrfTokens, csrfCookieValue)
      ) {
        sendText(response, 403, "Relácia formulára vypršala. Obnovte stránku.");
        return;
      }
      const session = cookies.get(ALPHA_GATE_SESSION_COOKIE);
      if (session !== undefined) sessions.delete(tokenDigest(session));
      response.setHeader("set-cookie", [
        clearCookie(ALPHA_GATE_SESSION_COOKIE),
        clearCookie(ALPHA_GATE_CSRF_COOKIE),
      ]);
      redirect(response, "/_alpha-gate/login?return=%2F");
      return;
    }

    sendText(response, 404, "Nenájdené");
  });
}

function renderLogin(
  response,
  { returnTarget, csrfTokens, now, error = null, status = 200 },
) {
  removeExpired(csrfTokens, now());
  const csrf = randomBytes(32).toString("base64url");
  csrfTokens.set(tokenDigest(csrf), now() + CSRF_TTL_SECONDS * 1_000);
  response.setHeader("set-cookie", csrfCookie(csrf));
  sendHtml(response, status, loginPage({ csrf, error, returnTarget }));
}

function loginPage({ csrf, error, returnTarget }) {
  return pageShell(
    "Vstup do testovacej verzie",
    `<main class="card">
      <p class="eyebrow">Remeselnícky portál</p>
      <h1>Testovacia Alpha</h1>
      <p class="intro">Pred vstupom sa prihláste do vonkajšej testovacej brány. Prihlásenie do samotného portálu zostáva samostatné.</p>
      ${error === null ? "" : `<p class="error" role="alert">${escapeHtml(error)}</p>`}
      <form method="post" action="/_alpha-gate/login">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="return" value="${escapeHtml(returnTarget)}">
        <label for="alpha-gate-username">Používateľ</label>
        <input id="alpha-gate-username" name="username" autocomplete="username" value="alpha" required maxlength="64">
        <label for="alpha-gate-password">Heslo</label>
        <input id="alpha-gate-password" name="password" type="password" autocomplete="current-password" required maxlength="256">
        <button type="submit">Vstúpiť do testovacej verzie</button>
      </form>
    </main>`,
  );
}

function logoutPage(csrf) {
  return pageShell(
    "Opustiť testovaciu verziu",
    `<main class="card">
      <p class="eyebrow">Remeselnícky portál</p>
      <h1>Opustiť testovaciu verziu</h1>
      <p class="intro">Týmto ukončíte iba vonkajšiu Alpha gate session. Prihlásenie do portálu sa nemení.</p>
      <form method="post" action="/_alpha-gate/logout">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button type="submit">Opustiť testovaciu verziu</button>
      </form>
    </main>`,
  );
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Remeselnícky portál</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f4f1e9; color: #17251e; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
    .card { width: min(100%, 520px); background: #fffdf8; border: 1px solid #d8d1c3; border-radius: 24px; padding: clamp(28px, 6vw, 48px); box-shadow: 0 24px 64px rgba(23, 37, 30, .12); }
    .eyebrow { margin: 0 0 12px; color: #315c47; font-size: 13px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(38px, 8vw, 58px); line-height: .98; letter-spacing: -.045em; }
    .intro { margin: 22px 0 28px; line-height: 1.6; }
    form { display: grid; gap: 10px; }
    label { margin-top: 8px; font-weight: 700; }
    input { width: 100%; border: 1px solid #9ea89f; border-radius: 12px; padding: 13px 14px; font: inherit; background: white; color: inherit; }
    input:focus { outline: 3px solid rgba(49, 92, 71, .22); border-color: #315c47; }
    button { margin-top: 14px; border: 0; border-radius: 12px; padding: 14px 18px; background: #215b38; color: white; font: inherit; font-weight: 800; cursor: pointer; }
    button:hover { background: #18482c; }
    .error { border-radius: 12px; padding: 12px 14px; background: #fce8e4; color: #7b251e; font-weight: 700; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function readForm(request, response) {
  if (
    !firstHeader(request.headers["content-type"])
      .toLowerCase()
      .startsWith("application/x-www-form-urlencoded")
  ) {
    sendText(response, 415, "Nepodporovaný formát požiadavky.");
    return null;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > LOGIN_BODY_LIMIT) {
        sendText(response, 413, "Požiadavka je príliš veľká.");
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    sendText(response, 400, "Požiadavku sa nepodarilo načítať.");
    return null;
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function parseCookies(value) {
  const result = new Map();
  if (typeof value !== "string") return result;
  for (const item of value.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const cookieValue = item.slice(separator + 1).trim();
    if (!result.has(name)) result.set(name, cookieValue);
  }
  return result;
}

function sessionCookie(value, lifetimeSeconds) {
  return `${ALPHA_GATE_SESSION_COOKIE}=${value}; Path=/; Max-Age=${lifetimeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function csrfCookie(value) {
  return `${ALPHA_GATE_CSRF_COOKIE}=${value}; Path=/; Max-Age=${CSRF_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function setSecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "same-origin");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

function sendHtml(response, status, body) {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.writeHead(status).end(body);
}

function sendText(response, status, body) {
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.writeHead(status).end(body);
}

function redirect(response, location) {
  response.setHeader("location", location);
  response.writeHead(303).end();
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function tokenDigest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeDigestEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeTextEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return safeDigestEqual(digest(left), digest(right));
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

function removeExpired(store, current) {
  for (const [key, value] of store) {
    const expiresAt = typeof value === "number" ? value : value.expiresAt;
    if (expiresAt <= current) store.delete(key);
  }
}

function trimOldest(store) {
  while (store.size > MAX_STATE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) return;
    store.delete(oldest);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function startProductionServer() {
  const passwordPath =
    process.env.ALPHA_GATE_PASSWORD_FILE ?? "/run/secrets/quick_gate_password";
  const password = (await readFile(passwordPath, "utf8")).trim();
  const sessionTtlSeconds = Number.parseInt(
    process.env.ALPHA_GATE_SESSION_TTL_SECONDS ??
      String(ALPHA_GATE_SESSION_TTL_SECONDS),
    10,
  );
  const port = Number.parseInt(process.env.PORT ?? "3002", 10);
  const server = createAlphaGateServer({ password, sessionTtlSeconds });
  server.listen(port, "0.0.0.0");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startProductionServer();
}
