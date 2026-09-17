import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requiredNames = [
  "STAGING_E2E_BASE_URL",
  "STAGING_E2E_CUSTOMER_EMAIL",
  "STAGING_E2E_CUSTOMER_PASSWORD",
  "STAGING_E2E_CUSTOMER_B_EMAIL",
  "STAGING_E2E_CUSTOMER_B_PASSWORD",
  "STAGING_E2E_PROVIDER_A_EMAIL",
  "STAGING_E2E_PROVIDER_A_PASSWORD",
  "STAGING_E2E_PROVIDER_B_EMAIL",
  "STAGING_E2E_PROVIDER_B_PASSWORD",
  "STAGING_E2E_REQUEST_A_ID",
  "STAGING_E2E_REQUEST_B_ID",
  "STAGING_E2E_INVITATION_A_ID",
  "STAGING_E2E_INVITATION_B_ID",
  "STAGING_E2E_CONVERSATION_A_ID",
  "STAGING_E2E_CONVERSATION_B_ID",
  "STAGING_E2E_MEDIA_A_ID",
  "STAGING_E2E_MEDIA_B_ID",
  "STAGING_E2E_QUOTE_A_ID",
  "STAGING_E2E_QUOTE_B_ID",
  "STAGING_E2E_PROVIDER_A_CANARY",
  "STAGING_E2E_PROVIDER_B_CANARY",
] as const;
const enabled = process.env.STAGING_E2E_ENABLED === "true";

test.skip(!enabled, "R3-022 staging accounts and fixtures are not provisioned");

test.beforeAll(() => {
  for (const name of requiredNames) {
    if (process.env[name] === undefined || process.env[name]?.length === 0) {
      throw new Error(`Staging E2E input ${name} is unavailable`);
    }
  }
  const url = new URL(required("STAGING_E2E_BASE_URL"));
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Staging E2E origin violates the TLS boundary");
  }
  for (const name of [
    "STAGING_E2E_REQUEST_A_ID",
    "STAGING_E2E_REQUEST_B_ID",
    "STAGING_E2E_INVITATION_A_ID",
    "STAGING_E2E_INVITATION_B_ID",
    "STAGING_E2E_CONVERSATION_A_ID",
    "STAGING_E2E_CONVERSATION_B_ID",
    "STAGING_E2E_MEDIA_A_ID",
    "STAGING_E2E_MEDIA_B_ID",
    "STAGING_E2E_QUOTE_A_ID",
    "STAGING_E2E_QUOTE_B_ID",
  ] as const) {
    if (!uuidPattern.test(required(name))) {
      throw new Error(`Staging E2E fixture ${name} is malformed`);
    }
  }
});

test("isolates competitor conversations and their private timeline", async ({
  browser,
}) => {
  const providerA = await authenticatedContext(browser, "PROVIDER_A");
  const providerB = await authenticatedContext(browser, "PROVIDER_B");
  const exact = await providerA.request.get(
    `/v1/me/conversations/${required("STAGING_E2E_CONVERSATION_A_ID")}/timeline`,
  );
  expect(exact.status()).toBe(200);
  expect(await exact.text()).toContain(
    required("STAGING_E2E_PROVIDER_A_CANARY"),
  );

  const competitor = await providerA.request.get(
    `/v1/me/conversations/${required("STAGING_E2E_CONVERSATION_B_ID")}/timeline`,
  );
  const unknown = await providerA.request.get(
    "/v1/me/conversations/ffffffff-ffff-4fff-8fff-ffffffffffff/timeline",
  );
  const competitorBody = await expectUniformPrivateNotFound(
    competitor,
    unknown,
  );
  expect(competitorBody).not.toContain(
    required("STAGING_E2E_PROVIDER_B_CANARY"),
  );
  const providerBExact = await providerB.request.get(
    `/v1/me/conversations/${required("STAGING_E2E_CONVERSATION_B_ID")}/timeline`,
  );
  expect(providerBExact.status()).toBe(200);
  expect(await providerBExact.text()).toContain(
    required("STAGING_E2E_PROVIDER_B_CANARY"),
  );
  await Promise.all([providerA.close(), providerB.close()]);
});

test("keeps Quote comparison customer-only", async ({ browser }) => {
  const customer = await authenticatedContext(browser, "CUSTOMER");
  const customerB = await authenticatedContext(browser, "CUSTOMER_B");
  const provider = await authenticatedContext(browser, "PROVIDER_A");
  const exactPath = `/v1/me/job-requests/${required("STAGING_E2E_REQUEST_A_ID")}/quote-comparison`;
  const exact = await customer.request.get(exactPath);
  expect(exact.status()).toBe(200);
  expect(exact.headers()["cache-control"]).toContain("no-store");
  const comparison = (await exact.json()) as {
    items?: readonly {
      quoteId?: unknown;
      price?: { totalAmountCents?: unknown };
    }[];
  };
  expect(comparison.items).toHaveLength(2);
  expect(comparison.items?.map((item) => item.quoteId).sort()).toEqual(
    [
      required("STAGING_E2E_QUOTE_A_ID"),
      required("STAGING_E2E_QUOTE_B_ID"),
    ].sort(),
  );
  expect(
    comparison.items?.map((item) => item.price?.totalAmountCents).sort(),
  ).toEqual([125000, 175000]);

  const providerDenied = await provider.request.get(exactPath);
  const foreign = await customer.request.get(
    `/v1/me/job-requests/${required("STAGING_E2E_REQUEST_B_ID")}/quote-comparison`,
  );
  await expectUniformPrivateNotFound(providerDenied, foreign);
  const customerBExact = await customerB.request.get(
    `/v1/me/job-requests/${required("STAGING_E2E_REQUEST_B_ID")}/quote-comparison`,
  );
  expect(customerBExact.status()).toBe(200);
  const customerBComparison = (await customerBExact.json()) as {
    items?: unknown[];
  };
  expect(customerBComparison.items).toHaveLength(0);
  await Promise.all([customer.close(), customerB.close(), provider.close()]);
});

test("does not expose a competitor's submitted Quote to a provider", async ({
  browser,
}) => {
  const providerA = await authenticatedContext(browser, "PROVIDER_A");
  const own = await providerA.request.get(
    `/v1/me/quotes/${required("STAGING_E2E_QUOTE_A_ID")}/revisions/1/structured`,
  );
  expect(own.status()).toBe(200);
  expect(await own.text()).toContain(required("STAGING_E2E_PROVIDER_A_CANARY"));
  const competitor = await providerA.request.get(
    `/v1/me/quotes/${required("STAGING_E2E_QUOTE_B_ID")}/revisions/1/structured`,
  );
  const unknown = await providerA.request.get(
    "/v1/me/quotes/ffffffff-ffff-4fff-8fff-ffffffffffff/revisions/1/structured",
  );
  const body = await expectUniformPrivateNotFound(competitor, unknown);
  expect(body).not.toContain(required("STAGING_E2E_PROVIDER_B_CANARY"));
  await providerA.close();
});

test("blocks pre-confirm contact sharing without adding a message", async ({
  browser,
}) => {
  const provider = await authenticatedContext(browser, "PROVIDER_A");
  const session = await provider.request.get("/v1/auth/session");
  expect(session.status()).toBe(200);
  const body = (await session.json()) as { csrfToken?: unknown };
  if (typeof body.csrfToken !== "string") {
    throw new Error("Authenticated CSRF token is unavailable");
  }
  const canary = "contact-probe@portal.invalid";
  const blocked = await provider.request.post(
    `/v1/me/conversations/${required("STAGING_E2E_CONVERSATION_A_ID")}/messages`,
    {
      data: { body: canary, commandId: randomUUID() },
      headers: { "x-csrf-token": body.csrfToken },
    },
  );
  expect(blocked.status()).toBe(422);
  expect(await blocked.json()).toEqual({
    code: "CONTACT_SHARING_NOT_AVAILABLE",
  });
  const timeline = await provider.request.get(
    `/v1/me/conversations/${required("STAGING_E2E_CONVERSATION_A_ID")}/timeline`,
  );
  expect(timeline.status()).toBe(200);
  expect(await timeline.text()).not.toContain(canary);
  await provider.close();
});

test("authorizes only the exact conversation member's canonical attachment", async ({
  browser,
}) => {
  const providerA = await authenticatedContext(browser, "PROVIDER_A");
  const own = await providerA.request.get(
    `/v1/media/${required("STAGING_E2E_MEDIA_A_ID")}/download`,
    { maxRedirects: 0 },
  );
  expect(own.status()).toBe(303);
  const location = own.headers()["location"];
  expect(location).toBeDefined();
  expect(new URL(location ?? "invalid:").protocol).toBe("https:");

  const competitor = await providerA.request.get(
    `/v1/media/${required("STAGING_E2E_MEDIA_B_ID")}/download`,
    { maxRedirects: 0 },
  );
  const unknown = await providerA.request.get(
    "/v1/media/ffffffff-ffff-4fff-8fff-ffffffffffff/download",
    { maxRedirects: 0 },
  );
  await expectUniformPrivateNotFound(competitor, unknown);
  expect(competitor.headers()).not.toHaveProperty("location");
  await providerA.close();
});

test("re-runs authorization on a competitor deep link", async ({ browser }) => {
  const providerA = await authenticatedContext(browser, "PROVIDER_A");
  const response = await providerA.request.get(
    `/v1/me/invitations/${required("STAGING_E2E_INVITATION_B_ID")}/conversation`,
  );
  expect(response.status()).toBe(404);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toContain("noindex, nofollow");
  expect(await response.text()).not.toContain(
    required("STAGING_E2E_PROVIDER_B_CANARY"),
  );
  await providerA.close();
});

async function authenticatedContext(
  browser: Browser,
  actor: "CUSTOMER" | "CUSTOMER_B" | "PROVIDER_A" | "PROVIDER_B",
): Promise<BrowserContext> {
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
    return context;
  }
  const csrf = await context.request.get("/v1/auth/csrf");
  expect(csrf.status()).toBe(200);
  const csrfPayload = (await csrf.json()) as unknown;
  if (
    typeof csrfPayload !== "object" ||
    csrfPayload === null ||
    !("csrfToken" in csrfPayload) ||
    typeof csrfPayload.csrfToken !== "string"
  ) {
    throw new Error("Staging CSRF response is malformed");
  }
  const login = await context.request.post("/v1/auth/login", {
    data: {
      email: required(`STAGING_E2E_${actor}_EMAIL`),
      password: required(`STAGING_E2E_${actor}_PASSWORD`),
    },
    headers: { "x-csrf-token": csrfPayload.csrfToken },
  });
  expect(login.status()).toBe(200);
  return context;
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
  ) {
    throw new Error("Cloudflare Access E2E credentials are incomplete");
  }
  if (
    (username === undefined) !== (password === undefined) ||
    (username !== undefined && (!username || !password))
  ) {
    throw new Error("Temporary alpha Basic Auth credentials are incomplete");
  }
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

async function expectUniformPrivateNotFound(
  first: APIResponse,
  second: APIResponse,
): Promise<string> {
  expect(first.status()).toBe(404);
  expect(second.status()).toBe(404);
  expect(first.headers()["cache-control"]).toContain("no-store");
  expect(second.headers()["cache-control"]).toContain("no-store");
  const firstBody = await first.text();
  expect(firstBody).toBe(await second.text());
  return firstBody;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Staging E2E input ${name} is unavailable`);
  }
  return value;
}
