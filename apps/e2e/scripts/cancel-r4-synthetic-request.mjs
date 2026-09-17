import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const requestId = process.argv.at(2);
const revision = Number(process.argv.at(3));
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
if (
  !requestId ||
  !uuid.test(requestId) ||
  !Number.isSafeInteger(revision) ||
  revision < 1
) {
  throw new Error("Supply an exact synthetic request ID and current revision.");
}

const root = new URL("../../../", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL(".alpha/r3-e2e-fixture.json", root), "utf8"),
);
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u.test(fixture.baseURL)) {
  throw new Error("Only the isolated Quick Tunnel fixture is supported.");
}
const gate = (
  await readFile(new URL(".alpha/secrets/quick_gate_password", root), "utf8")
).trim();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    baseURL: fixture.baseURL,
    httpCredentials: {
      origin: fixture.baseURL,
      username: "alpha",
      password: gate,
    },
    storageState: fileURLToPath(new URL(".alpha/r3-e2e-auth-104.json", root)),
  });
  try {
    const snapshotResponse = await context.request.get(
      `/v1/me/job-requests/${requestId}`,
    );
    if (snapshotResponse.status() !== 200)
      throw new Error("Owned request snapshot unavailable.");
    const snapshot = await snapshotResponse.json();
    const core = snapshot.sections?.find((item) => item.key === "request.core");
    if (!core?.payload?.title?.startsWith("Syntetické potvrdenie ")) {
      throw new Error(
        "Refusing to cancel a request outside the R4 synthetic fixture.",
      );
    }
    const sessionResponse = await context.request.get("/v1/auth/session");
    if (sessionResponse.status() !== 200)
      throw new Error("Customer session unavailable.");
    const token = (await sessionResponse.json()).csrfToken;
    if (typeof token !== "string" || token.length === 0)
      throw new Error("CSRF unavailable.");
    const response = await context.request.post(
      `/v1/me/job-requests/${requestId}/cancel`,
      {
        data: {
          commandId: randomUUID(),
          expectedRevision: revision,
          reason: "OTHER",
        },
        headers: { "x-csrf-token": token },
      },
    );
    if (response.status() !== 200)
      throw new Error(`Synthetic cancellation HTTP ${response.status()}.`);
    process.stdout.write(
      "Failed R4 synthetic request cancelled through its customer command.\n",
    );
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}
