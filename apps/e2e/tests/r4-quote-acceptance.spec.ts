import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

test.skip(
  process.env.STAGING_E2E_ENABLED !== "true",
  "Synthetic public alpha fixture is not provisioned",
);

test("acceptQuote never admits a Basic-Auth visitor without a portal session", async ({
  browser,
}) => {
  const baseURL = requiredEnv("STAGING_E2E_BASE_URL");
  const context = await browser.newContext({
    baseURL,
    ...accessHeaders(baseURL),
  });
  try {
    const csrf = await context.request.get("/v1/auth/csrf");
    expect(csrf.status()).toBe(200);
    const token = requiredString(
      ((await csrf.json()) as Record<string, unknown>)["csrfToken"],
    );
    const response = await context.request.post(
      `/v1/me/job-requests/${randomUUID()}/quotes/${randomUUID()}/accept`,
      {
        data: {
          commandId: randomUUID(),
          explicitlyConfirmed: true,
          expectedQuoteStateRevision: 1,
          expectedRequestContentRevision: 1,
          expectedRequestVisibleVersion: 1,
          quoteRevision: 1,
        },
        headers: { "x-csrf-token": token },
      },
    );
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  } finally {
    await context.close();
  }
});

test("one explicit acceptance creates one Job, closes competitors and unlocks only its parties", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  test.skip(
    browserName !== "chromium",
    "One committing transaction is sufficient",
  );
  const customer = await authenticated(browser, "CUSTOMER_B");
  const winner = await authenticated(browser, "PROVIDER_A");
  const competitor = await authenticated(browser, "PROVIDER_B");
  try {
    const search = await read(
      customer.context,
      "/v1/public/craftsmen/search?professionCode=PROF%3AALPHA_SYNTHETIC",
    );
    const profiles = search.items as Array<{
      identity?: { primaryName?: string };
      profileId?: string;
    }>;
    const winnerProfileId = profileId(profiles, "Testovací remeselník Alfa");
    const competitorProfileId = profileId(profiles, "Syntetická dielňa Beta");
    const requestTitle = `Syntetické potvrdenie ${randomUUID().slice(0, 8)}`;
    const request = await post(
      customer,
      "/v1/me/job-request-drafts",
      {
        commandId: randomUUID(),
        section: {
          key: "request.core",
          schemaVersion: 1,
          payload: {
            description: "Syntetické overenie záverečného potvrdenia ponuky.",
            primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
            relatedProfessionCodes: [],
            skillCodes: [],
            specializationCode: null,
            title: requestTitle,
          },
        },
      },
      201,
    );
    const requestId = requiredString(request.id);
    const located = await post(
      customer,
      `/v1/me/job-request-drafts/${requestId}/sections`,
      {
        commandId: randomUUID(),
        expectedRevision: request.revision,
        section: {
          key: "request.location",
          schemaVersion: 1,
          payload: {
            exactAddress: null,
            mapPin: null,
            municipalityCode: "TEST:MUNICIPALITY_ALPHA",
            textClarification: null,
          },
        },
      },
      200,
    );
    await post(
      customer,
      `/v1/me/job-request-drafts/${requestId}/activate`,
      { commandId: randomUUID(), expectedRevision: located.revision },
      200,
    );

    const winning = await prepareQuote(
      customer,
      winner,
      requestId,
      winnerProfileId,
      "A",
    );
    const losing = await prepareQuote(
      customer,
      competitor,
      requestId,
      competitorProfileId,
      "B",
    );
    const recapPath = `/ziadosti/${requestId}/ponuky/${winning.quoteId}/potvrdenie`;
    const page = await customer.context.newPage();
    expect((await page.goto(recapPath))?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Rekapitulácia vybranej ponuky" }),
    ).toBeVisible();
    await expect(page.getByText("TEST:MUNICIPALITY_ALPHA")).toBeVisible();
    const before = await read(
      customer.context,
      `/v1/me/quotes/${winning.quoteId}/lifecycle?quoteRevision=1`,
    );
    expect(before.state).toBe("SUBMITTED");
    await page
      .getByLabel("Presná adresa práce, ak je potrebná")
      .fill("Syntetická 47");
    const confirmation = page.waitForResponse((response) =>
      response
        .url()
        .endsWith(
          `/v1/me/job-requests/${requestId}/quotes/${winning.quoteId}/accept`,
        ),
    );
    await page
      .getByRole("button", { name: "Potvrdiť ponuku a vytvoriť zákazku" })
      .click();
    const accepted = await confirmation;
    expect(accepted.status()).toBe(201);
    const body = (await accepted.json()) as Record<string, unknown>;
    const jobId = requiredString(body.jobId);
    expect(body.status).toBe("APPLIED");
    await expect(
      page.getByRole("heading", { name: "Zákazka je potvrdená" }),
    ).toBeVisible();
    const ownedRequests = await read(customer.context, "/v1/me/job-requests");
    expect(
      (ownedRequests.requests as Array<{ id: string; state: string }>).find(
        (item) => item.id === requestId,
      )?.state,
    ).toBe("CONVERTED");
    const losingInvitation = await read(
      competitor.context,
      `/v1/me/invitations/${losing.invitationId}`,
    );
    expect(losingInvitation.state).toBe("NOT_SELECTED");

    const originalCommand = accepted.request().postDataJSON() as Record<
      string,
      unknown
    >;
    const replay = await customer.context.request.post(
      `/v1/me/job-requests/${requestId}/quotes/${winning.quoteId}/accept`,
      {
        data: originalCommand,
        headers: { "x-csrf-token": customer.csrfToken },
      },
    );
    expect(replay.status()).toBe(200);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody["jobId"]).toBe(jobId);
    const second = await customer.context.request.post(
      `/v1/me/job-requests/${requestId}/quotes/${losing.quoteId}/accept`,
      {
        data: { ...originalCommand, commandId: randomUUID() },
        headers: { "x-csrf-token": customer.csrfToken },
      },
    );
    expect(second.status()).toBe(409);

    const contactPath = `/v1/me/jobs/${jobId}/contacts`;
    const customerContact = await customer.context.request.get(contactPath);
    expect(customerContact.status()).toBe(200);
    expect(customerContact.headers()["cache-control"]).toContain("no-store");
    const contact = (await customerContact.json()) as Record<string, unknown>;
    expect(
      (contact["workLocation"] as Record<string, unknown>)["exactAddress"],
    ).toBe("Syntetická 47");
    expect((await winner.context.request.get(contactPath)).status()).toBe(200);
    expect((await competitor.context.request.get(contactPath)).status()).toBe(
      404,
    );
    const jobPath = `/v1/me/jobs/${jobId}`;
    const customerJob = await read(customer.context, jobPath);
    expect(customerJob.state).toBe("CONFIRMED");
    expect((customerJob.request as Record<string, unknown>).title).toBe(
      requestTitle,
    );
    expect((await winner.context.request.get(jobPath)).status()).toBe(200);
    expect((await competitor.context.request.get(jobPath)).status()).toBe(404);
    const ownedJobs = await read(customer.context, "/v1/me/jobs");
    expect(
      (ownedJobs.jobs as Array<{ id: string }>).some((job) => job.id === jobId),
    ).toBe(true);
    const competitorJobs = await read(competitor.context, "/v1/me/jobs");
    expect(
      (competitorJobs.jobs as Array<{ id: string }>).some(
        (job) => job.id === jobId,
      ),
    ).toBe(false);
    expect((await page.goto(`/zakazky/${jobId}`))?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Kontakty a miesto výkonu" }),
    ).toBeVisible();
    await expect(page.getByText("Syntetická 47")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Otvoriť pokračujúcu konverzáciu" }),
    ).toHaveAttribute("href", `/konverzacie/pozvanka/${winning.invitationId}`);
    const continued = await read(
      winner.context,
      `/v1/me/invitations/${winning.invitationId}/conversation`,
    );
    expect(continued.id).toBe(winning.conversationId);
    await post(
      winner,
      `/v1/me/conversations/${winning.conversationId}/messages`,
      {
        body: "Syntetická správa po potvrdení zákazky.",
        commandId: randomUUID(),
      },
      201,
    );
  } finally {
    await Promise.all([
      customer.context.close(),
      winner.context.close(),
      competitor.context.close(),
    ]);
  }
});

async function prepareQuote(
  customer: Actor,
  provider: Actor,
  requestId: string,
  profileId: string,
  label: string,
): Promise<{ conversationId: string; invitationId: string; quoteId: string }> {
  const invitation = await post(
    customer,
    `/v1/me/job-requests/${requestId}/invitations`,
    { commandId: randomUUID(), craftsmanProfileId: profileId },
    201,
  );
  const invitationId = requiredString(invitation.id);
  const current = await read(
    provider.context,
    `/v1/me/invitations/${invitationId}`,
  );
  await post(
    provider,
    `/v1/me/invitations/${invitationId}/respond`,
    {
      action: "ENGAGE",
      commandId: randomUUID(),
      expectedRevision: current.revision,
    },
    200,
  );
  const engaged = await read(
    provider.context,
    `/v1/me/invitations/${invitationId}`,
  );
  const conversation = await read(
    provider.context,
    `/v1/me/invitations/${invitationId}/conversation`,
  );
  const conversationId = requiredString(conversation.id);
  const created = await post(
    provider,
    `/v1/me/conversations/${conversationId}/quotes`,
    {
      authoringMode: "PLATFORM_STRUCTURED",
      commandId: randomUUID(),
      requestContentRevision: engaged.requestContentRevision,
      requestVisibleVersion: engaged.requestVisibleVersion,
    },
    201,
  );
  const quoteId = requiredString((created.quote as Record<string, unknown>).id);
  await post(
    provider,
    `/v1/me/quotes/${quoteId}/revisions/1/structured`,
    {
      commandId: randomUUID(),
      expectedContentRevision: 0,
      content: {
        components: {},
        conditionalOnInspection: false,
        currency: "EUR",
        materialResponsibility: "PROVIDER",
        priceBasis: "Cena za syntetické práce.",
        priceMode: "FIXED",
        summary: `Syntetická ponuka ${label}`,
        title: `Syntetická ponuka ${label}`,
        totalAmountCents: label === "A" ? 125000 : 175000,
        vatStatus: "VAT_INCLUDED",
      },
    },
    200,
  );
  const draft = await read(provider.context, `/v1/me/quotes/${quoteId}`);
  await post(
    provider,
    `/v1/me/quotes/${quoteId}/revisions/1/submit`,
    {
      commandId: randomUUID(),
      expectedDraftStateRevision: (
        draft.currentDraft as Record<string, unknown>
      ).stateRevision,
      expectedSubmittedStateRevision: null,
    },
    200,
  );
  return { conversationId, invitationId, quoteId };
}

interface Actor {
  readonly context: BrowserContext;
  readonly csrfToken: string;
}

async function authenticated(
  browser: Browser,
  role: "CUSTOMER_B" | "PROVIDER_A" | "PROVIDER_B",
): Promise<Actor> {
  const baseURL = requiredEnv("STAGING_E2E_BASE_URL");
  const context = await browser.newContext({
    baseURL,
    ...accessHeaders(baseURL),
    storageState: requiredEnv(`STAGING_E2E_${role}_AUTH_STATE`),
  });
  const response = await context.request.get("/v1/auth/session");
  expect(response.status()).toBe(200);
  const session = (await response.json()) as Record<string, unknown>;
  return { context, csrfToken: requiredString(session.csrfToken) };
}

function accessHeaders(baseURL: string): Readonly<{
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { origin: string; password: string; username: string };
}> {
  const clientId = process.env.STAGING_E2E_CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.STAGING_E2E_CF_ACCESS_CLIENT_SECRET;
  if (clientId !== undefined && clientSecret !== undefined)
    return {
      extraHTTPHeaders: {
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
    };
  const username = process.env.STAGING_E2E_BASIC_AUTH_USERNAME;
  const password = process.env.STAGING_E2E_BASIC_AUTH_PASSWORD;
  if (username !== undefined && password !== undefined)
    return { httpCredentials: { origin: baseURL, password, username } };
  return {};
}

async function read(
  context: BrowserContext,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await context.request.get(path);
  return checked(response, 200);
}

async function post(
  actor: Actor,
  path: string,
  data: unknown,
  expected: number,
): Promise<Record<string, unknown>> {
  const response = await actor.context.request.post(path, {
    data,
    headers: { "x-csrf-token": actor.csrfToken },
  });
  return checked(response, expected);
}

async function checked(
  response: APIResponse,
  expected: number,
): Promise<Record<string, unknown>> {
  expect(response.status()).toBe(expected);
  return (await response.json()) as Record<string, unknown>;
}

function profileId(
  profiles: Array<{ identity?: { primaryName?: string }; profileId?: string }>,
  name: string,
): string {
  const matches = profiles.filter(
    (profile) => profile.identity?.primaryName === name,
  );
  expect(matches).toHaveLength(1);
  return requiredString(matches[0]?.profileId);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Synthetic E2E response is missing a required field");
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`Missing synthetic E2E input ${name}`);
  return value;
}
