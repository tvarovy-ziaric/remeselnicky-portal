import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

const enabled = process.env.STAGING_E2E_ENABLED === "true";
const requiredNames = [
  "STAGING_E2E_BASE_URL",
  "STAGING_E2E_PROVIDER_A_EMAIL",
  "STAGING_E2E_PROVIDER_A_PASSWORD",
  "STAGING_E2E_PROVIDER_B_EMAIL",
  "STAGING_E2E_PROVIDER_B_PASSWORD",
  "STAGING_E2E_CONVERSATION_A_ID",
] as const;

test.skip(!enabled, "Public alpha private-media fixtures are not provisioned");

test.beforeAll(() => {
  for (const name of requiredNames) required(name);
});

test("keeps clean PDF processing private and rejects EICAR", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  test.skip(
    browserName !== "chromium",
    "One malware pipeline run is sufficient",
  );
  const provider = await authenticated(browser, "PROVIDER_A");
  const competitor = await authenticated(browser, "PROVIDER_B");
  const conversationId = required("STAGING_E2E_CONVERSATION_A_ID");
  const messageId = await sendSourceMessage(provider, conversationId);

  if (process.env.STAGING_E2E_LOCAL_COMPOSE_CONTROL === "true") {
    compose("stop", "worker");
  }
  try {
    const cleanAssetId = await uploadPdf(
      provider,
      conversationId,
      messageId,
      minimalPdf(),
    );
    await expectPrivateUnavailable(provider.context, cleanAssetId);

    if (process.env.STAGING_E2E_LOCAL_COMPOSE_CONTROL === "true") {
      compose("start", "worker");
    }
    await expectStatus(provider.context, conversationId, cleanAssetId, "READY");

    const authorized = await provider.context.request.get(
      `/v1/media/${cleanAssetId}/download`,
      { maxRedirects: 0 },
    );
    expect(authorized.status()).toBe(303);
    const location = authorized.headers()["location"];
    expect(location).toBeDefined();
    const downloaded = await provider.context.request.get(
      location ?? "invalid:",
    );
    expect(downloaded.status()).toBe(200);
    expect((await downloaded.body()).subarray(0, 5).toString("latin1")).toBe(
      "%PDF-",
    );
    await expectPrivateUnavailable(competitor.context, cleanAssetId);

    const anonymous = await browser.newContext({
      baseURL: required("STAGING_E2E_BASE_URL"),
      ...accessHeaders(),
    });
    const anonymousDownload = await anonymous.request.get(
      `/v1/media/${cleanAssetId}/download`,
      { maxRedirects: 0 },
    );
    expect([401, 404]).toContain(anonymousDownload.status());
    expect(anonymousDownload.headers()).not.toHaveProperty("location");
    await anonymous.close();

    const eicarAssetId = await uploadPdf(
      provider,
      conversationId,
      messageId,
      minimalPdf(
        "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
      ),
    );
    await expectStatus(
      provider.context,
      conversationId,
      eicarAssetId,
      "REJECTED",
    );
    await expectPrivateUnavailable(provider.context, eicarAssetId);
  } finally {
    if (process.env.STAGING_E2E_LOCAL_COMPOSE_CONTROL === "true") {
      compose("start", "worker");
    }
    await Promise.all([provider.context.close(), competitor.context.close()]);
  }
});

async function authenticated(
  browser: Browser,
  actor: "PROVIDER_A" | "PROVIDER_B",
): Promise<Readonly<{ context: BrowserContext; csrfToken: string }>> {
  const context = await browser.newContext({
    baseURL: required("STAGING_E2E_BASE_URL"),
    ...accessHeaders(),
    ...(process.env[`STAGING_E2E_${actor}_AUTH_STATE`] === undefined
      ? {}
      : { storageState: required(`STAGING_E2E_${actor}_AUTH_STATE`) }),
  });
  if (process.env[`STAGING_E2E_${actor}_AUTH_STATE`] !== undefined) {
    const session = await context.request.get("/v1/auth/session");
    expect(session.status()).toBe(200);
    const body = (await session.json()) as { csrfToken?: unknown };
    if (typeof body.csrfToken !== "string")
      throw new Error("Malformed authenticated session CSRF response");
    return Object.freeze({ context, csrfToken: body.csrfToken });
  }
  const csrf = await context.request.get("/v1/auth/csrf");
  expect(csrf.status()).toBe(200);
  const payload = (await csrf.json()) as { csrfToken?: unknown };
  if (typeof payload.csrfToken !== "string")
    throw new Error("Malformed CSRF response");
  const login = await context.request.post("/v1/auth/login", {
    data: {
      email: required(`STAGING_E2E_${actor}_EMAIL`),
      password: required(`STAGING_E2E_${actor}_PASSWORD`),
    },
    headers: { "x-csrf-token": payload.csrfToken },
  });
  expect(login.status()).toBe(200);
  const authenticatedCsrf = await context.request.get("/v1/auth/csrf");
  expect(authenticatedCsrf.status()).toBe(200);
  const authenticatedPayload = (await authenticatedCsrf.json()) as {
    csrfToken?: unknown;
  };
  if (typeof authenticatedPayload.csrfToken !== "string")
    throw new Error("Malformed authenticated CSRF response");
  return Object.freeze({ context, csrfToken: authenticatedPayload.csrfToken });
}

async function sendSourceMessage(
  actor: Readonly<{ context: BrowserContext; csrfToken: string }>,
  conversationId: string,
): Promise<string> {
  const response = await actor.context.request.post(
    `/v1/me/conversations/${conversationId}/messages`,
    {
      data: {
        body: `Synthetic alpha media probe ${randomUUID()
          .replaceAll("-", "")
          .replace(/[0-9a-f]/gu, (digit) =>
            String.fromCharCode(97 + Number.parseInt(digit, 16)),
          )}`,
        commandId: randomUUID(),
      },
      headers: { "x-csrf-token": actor.csrfToken },
    },
  );
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { entry?: { id?: unknown } };
  if (typeof body.entry?.id !== "string")
    throw new Error("Message response is malformed");
  return body.entry.id;
}

async function uploadPdf(
  actor: Readonly<{ context: BrowserContext; csrfToken: string }>,
  conversationId: string,
  messageId: string,
  body: Uint8Array,
): Promise<string> {
  const response = await actor.context.request.post(
    `/v1/me/conversations/${conversationId}/messages/${messageId}/attachments/documents`,
    {
      data: Buffer.from(body),
      headers: {
        "content-type": "application/pdf",
        "x-csrf-token": actor.csrfToken,
      },
    },
  );
  expect(response.status()).toBe(202);
  const payload = (await response.json()) as {
    assetId?: unknown;
    status?: unknown;
  };
  expect(payload.status).toBe("PROCESSING");
  if (typeof payload.assetId !== "string")
    throw new Error("Upload response is malformed");
  return payload.assetId;
}

async function expectStatus(
  context: BrowserContext,
  conversationId: string,
  assetId: string,
  expected: "READY" | "REJECTED",
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await context.request.get(
          `/v1/me/conversations/${conversationId}/timeline?limit=50`,
        );
        if (response.status() !== 200) return "HTTP_ERROR";
        const payload = (await response.json()) as {
          entries?: readonly {
            attachments?: readonly { assetId?: unknown; status?: unknown }[];
          }[];
        };
        for (const entry of payload.entries ?? []) {
          const attachment = entry.attachments?.find(
            (candidate) => candidate.assetId === assetId,
          );
          if (typeof attachment?.status === "string") return attachment.status;
        }
        return "MISSING";
      },
      { timeout: 120_000 },
    )
    .toBe(expected);
}

async function expectPrivateUnavailable(
  context: BrowserContext,
  assetId: string,
): Promise<void> {
  const response = await context.request.get(`/v1/media/${assetId}/download`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(404);
  expect(response.headers()).not.toHaveProperty("location");
  expect(response.headers()["cache-control"]).toContain("no-store");
}

function minimalPdf(comment = "synthetic clean alpha fixture"): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let pdf = `%PDF-1.7\n% ${comment}\n`;
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += object;
  }
  const xrefOffset = encoder.encode(pdf).byteLength;
  pdf += "xref\n0 5\n0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function accessHeaders(): Readonly<{
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string; origin: string };
}> {
  const clientId = process.env.STAGING_E2E_CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.STAGING_E2E_CF_ACCESS_CLIENT_SECRET;
  const username = process.env.STAGING_E2E_BASIC_AUTH_USERNAME;
  const password = process.env.STAGING_E2E_BASIC_AUTH_PASSWORD;
  if (
    (clientId === undefined) !== (clientSecret === undefined) ||
    (clientId !== undefined && (!clientId || !clientSecret))
  )
    throw new Error("Cloudflare Access credentials are incomplete");
  if (
    (username === undefined) !== (password === undefined) ||
    (username !== undefined && (!username || !password))
  )
    throw new Error("Temporary alpha Basic Auth credentials are incomplete");
  return {
    ...(clientId === undefined || clientSecret === undefined
      ? {}
      : {
          extraHTTPHeaders: {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          },
        }),
    ...(username === undefined || password === undefined
      ? {}
      : {
          httpCredentials: {
            username,
            password,
            origin: required("STAGING_E2E_BASE_URL"),
          },
        }),
  };
}

function compose(...args: string[]): void {
  const repository = path.resolve(import.meta.dirname, "../../..");
  execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      path.join(repository, ".env.alpha"),
      "--file",
      path.join(repository, "compose.alpha.yaml"),
      ...args,
    ],
    { cwd: repository, stdio: "ignore" },
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Staging E2E input ${name} is unavailable`);
  }
  return value;
}
