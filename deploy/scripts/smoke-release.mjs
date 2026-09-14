import { assertRevision } from "./release-manifest.mjs";
import { pathToFileURL } from "node:url";

export async function runReleaseSmoke(input) {
  assertRevision(input.expectedRevision);
  const webUrl = safeBaseUrl(input.webUrl);
  const apiUrl = safeBaseUrl(input.apiUrl);
  const metricsUrl = safeBaseUrl(input.metricsUrl);
  const fetcher = input.fetcher ?? fetch;

  await expectStatus(fetcher, new URL("/", webUrl), "public web");
  const live = await expectJson(
    fetcher,
    new URL("/health/live", apiUrl),
    "API liveness",
  );
  if (live.status !== "ok") throw new Error("API liveness payload is invalid.");
  const ready = await expectJson(
    fetcher,
    new URL("/health/ready", apiUrl),
    "API readiness",
  );
  if (ready.status !== "ready" || ready.checks?.database !== "available") {
    throw new Error("API readiness did not prove database availability.");
  }
  const csrf = await expectJson(
    fetcher,
    new URL("/v1/auth/csrf", apiUrl),
    "auth entrypoint",
    true,
  );
  if (typeof csrf.csrfToken !== "string" || csrf.csrfToken.length < 16) {
    throw new Error("Auth entrypoint did not return a usable CSRF challenge.");
  }
  const metrics = await expectText(
    fetcher,
    new URL("/metrics", metricsUrl),
    "release metrics",
  );
  const escaped = input.expectedRevision.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  if (!new RegExp(`release_revision="${escaped}"`, "u").test(metrics)) {
    throw new Error(
      "Monitoring does not expose the expected release revision.",
    );
  }
  return Object.freeze({
    apiLive: true,
    authEntrypoint: true,
    databaseReady: true,
    publicWeb: true,
    releaseRevisionVisible: true,
  });
}

async function expectJson(fetcher, url, label, requireNoStore = false) {
  const response = await requestWithRetry(fetcher, url);
  if (response.status !== 200)
    throw new Error(`${label} returned a non-200 status.`);
  if (
    requireNoStore &&
    !response.headers.get("cache-control")?.toLowerCase().includes("no-store")
  ) {
    throw new Error(`${label} response is cacheable.`);
  }
  const body = await boundedText(response, 16_384, label);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
}

async function expectStatus(fetcher, url, label) {
  const response = await requestWithRetry(fetcher, url);
  if (response.status !== 200)
    throw new Error(`${label} returned a non-200 status.`);
  await response.body?.cancel();
}

async function expectText(fetcher, url, label) {
  const response = await requestWithRetry(fetcher, url);
  if (response.status !== 200)
    throw new Error(`${label} returned a non-200 status.`);
  return boundedText(response, 1_048_576, label);
}

async function requestWithRetry(fetcher, url) {
  let response;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      response = await fetcher(url, {
        headers: { accept: "application/json, text/plain;q=0.5" },
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status < 500) return response;
      await response.body?.cancel();
    } catch {
      // A bounded retry tolerates rollout/port-forward readiness without
      // reflecting URLs, cookies or response bodies into logs.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Release smoke endpoint remained unavailable.");
}

async function boundedText(response, maximumBytes, label) {
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maximumBytes) {
    throw new Error(`${label} response exceeded the smoke limit.`);
  }
  return body;
}

function safeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Smoke base URL is malformed.");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(
    url.hostname.toLowerCase(),
  );
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Smoke base URL violates the TLS/credential boundary.");
  }
  return url;
}

async function main() {
  const result = await runReleaseSmoke({
    apiUrl: process.env.SMOKE_API_URL,
    expectedRevision: process.env.EXPECTED_RELEASE_REVISION,
    metricsUrl: process.env.SMOKE_METRICS_URL,
    webUrl: process.env.SMOKE_WEB_URL,
  });
  process.stdout.write(
    `Release smoke passed for ${process.env.EXPECTED_RELEASE_REVISION}: ${Object.keys(result).join(", ")}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
