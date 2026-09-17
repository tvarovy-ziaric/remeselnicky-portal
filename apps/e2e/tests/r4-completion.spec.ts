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
  "Synthetic public Alpha is not provisioned",
);

test("fresh synthetic Job preserves bilateral completion attempts and private history", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(240_000);
  test.skip(browserName !== "chromium", "One synthetic mutation is sufficient");
  const customer = await authenticated(browser, "CUSTOMER_B");
  const provider = await authenticated(browser, "PROVIDER_B");
  const outsider = await authenticated(browser, "CUSTOMER_A");
  try {
    const jobId = await createJob(customer, provider);
    const jobPath = `/v1/me/jobs/${jobId}`;
    const completionPath = `${jobPath}/completion`;
    const original = agreement(await get(customer, jobPath));
    expect((await outsider.context.request.get(completionPath)).status()).toBe(
      404,
    );
    expect(
      (
        await post(customer, `${completionPath}/request`, {
          commandId: randomUUID(),
        })
      ).status(),
    ).toBe(404);
    const first = await checked(
      await post(provider, `${completionPath}/request`, {
        commandId: randomUUID(),
        note: "Syntetické odovzdanie na kontrolu.",
        finalMediaAssetIds: [],
      }),
      201,
    );
    expect(first.jobState).toBe("COMPLETION_REQUESTED");
    const firstId = requiredString(first.attemptId);
    expect((await get(customer, jobPath)).state).toBe("COMPLETION_REQUESTED");
    expect(
      (
        await post(provider, `${completionPath}/${firstId}/accept`, {
          commandId: randomUUID(),
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await post(outsider, `${completionPath}/${firstId}/reject`, {
          commandId: randomUUID(),
          category: "DEFECT",
          reason: "Syntetická výhrada k dokončeniu.",
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await post(customer, `${completionPath}/${firstId}/reject`, {
          commandId: randomUUID(),
          category: "DEFECT",
          reason: "Krátke",
        })
      ).status(),
    ).toBe(400);
    const rejected = await checked(
      await post(customer, `${completionPath}/${firstId}/reject`, {
        commandId: randomUUID(),
        category: "MISSING_OUTPUT",
        reason: "Chýba syntetický odovzdávací výstup.",
        evidenceMediaAssetIds: [],
      }),
      201,
    );
    expect(rejected.jobState).toBe("IN_PROGRESS");
    expect(
      (
        await post(customer, `${completionPath}/${firstId}/accept`, {
          commandId: randomUUID(),
        })
      ).status(),
    ).toBe(409);
    const second = await checked(
      await post(provider, `${completionPath}/request`, {
        commandId: randomUUID(),
        note: "Výhrada bola odstránená; druhé syntetické odovzdanie.",
      }),
      201,
    );
    const secondId = requiredString(second.attemptId);
    const pending = await get(customer, completionPath);
    expect(pending.jobState).toBe("COMPLETION_REQUESTED");
    expect(pending.attempts).toEqual([
      expect.objectContaining({
        id: secondId,
        attemptNumber: 2,
        outcome: "PENDING",
      }),
      expect.objectContaining({
        id: firstId,
        attemptNumber: 1,
        outcome: "REJECTED",
        rejectionCategory: "MISSING_OUTPUT",
        rejectionReason: "Chýba syntetický odovzdávací výstup.",
      }),
    ]);
    expect(JSON.stringify(pending)).not.toContain("requestedByUserId");
    expect(JSON.stringify(pending)).not.toContain("finalMediaAssetIds");
    const page = await customer.context.newPage();
    expect((await page.goto(`/zakazky/${jobId}`))?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Rozhodnúť o dokončení" }),
    ).toBeVisible();
    await expect(page.getByText("Pokus 1", { exact: false })).toBeVisible();
    const accepted = await checked(
      await post(customer, `${completionPath}/${secondId}/accept`, {
        commandId: randomUUID(),
      }),
      201,
    );
    expect(accepted.jobState).toBe("COMPLETED");
    const finished = await get(customer, jobPath);
    expect(finished.state).toBe("COMPLETED");
    expect(agreement(finished)).toEqual(original);
    expect(
      (
        await post(customer, `${jobPath}/change-orders`, {
          commandId: randomUUID(),
          revisionId: randomUUID(),
          terms: {
            title: "Neplatná zmena po dokončení",
            reason: "Syntetická kontrola uzavretej zákazky.",
            changeDescription: "Nová práca sa musí riešiť novou zákazkou.",
            scopeAdded: ["Nová montáž"],
            scopeRemoved: [],
            scopeChanged: [],
            priceImpact: {
              mode: "FIXED_DELTA",
              amountCents: 1000,
              vatStatus: "VAT_INCLUDED",
            },
            scheduleImpact: { mode: "NONE" },
            materialResponsibility: null,
            warrantyChange: null,
            otherConditionChange: null,
            affectedMilestoneIds: [],
            externalPdfMediaAssetId: null,
          },
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await post(provider, `${completionPath}/request`, {
          commandId: randomUUID(),
        })
      ).status(),
    ).toBe(409);
    const history = (await get(provider, completionPath)).attempts;
    if (!Array.isArray(history))
      throw new Error("Synthetic completion history missing");
    expect(
      (history as unknown[]).some(
        (item) =>
          record(item) && item.id === secondId && item.outcome === "ACCEPTED",
      ),
    ).toBe(true);
    expect((await outsider.context.request.get(jobPath)).status()).toBe(404);
    expect((await outsider.context.request.get(completionPath)).status()).toBe(
      404,
    );
    await page.reload();
    await expect(page.getByText("Dokončená zákazka")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Potvrdiť dokončenie" }),
    ).toHaveCount(0);
  } finally {
    await Promise.all([
      customer.context.close(),
      provider.context.close(),
      outsider.context.close(),
    ]);
  }
});

async function createJob(customer: Actor, provider: Actor): Promise<string> {
  const search = await get(
    customer,
    "/v1/public/craftsmen/search?professionCode=PROF%3AALPHA_SYNTHETIC",
  );
  if (!Array.isArray(search.items)) throw new Error("Synthetic search missing");
  const items = search.items as unknown[];
  const profile = items.find(
    (item: unknown) =>
      record(item) &&
      record(item.identity) &&
      item.identity.primaryName === "Syntetická dielňa Beta",
  );
  if (!record(profile)) throw new Error("Synthetic provider missing");
  const profileId = requiredString(profile.profileId);
  const draft = await checked(
    await post(customer, "/v1/me/job-request-drafts", {
      commandId: randomUUID(),
      section: {
        key: "request.core",
        schemaVersion: 1,
        payload: {
          description: "Syntetický test uzavretia samostatnej zákazky.",
          primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
          relatedProfessionCodes: [],
          skillCodes: [],
          specializationCode: null,
          title: `Syntetické odovzdanie ${randomUUID().slice(0, 8)}`,
        },
      },
    }),
    201,
  );
  const requestId = requiredString(draft.id);
  const located = await checked(
    await post(customer, `/v1/me/job-request-drafts/${requestId}/sections`, {
      commandId: randomUUID(),
      expectedRevision: draft.revision,
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
    }),
    200,
  );
  await checked(
    await post(customer, `/v1/me/job-request-drafts/${requestId}/activate`, {
      commandId: randomUUID(),
      expectedRevision: located.revision,
    }),
    200,
  );
  const invitation = await checked(
    await post(customer, `/v1/me/job-requests/${requestId}/invitations`, {
      commandId: randomUUID(),
      craftsmanProfileId: profileId,
    }),
    201,
  );
  const invitationId = requiredString(invitation.id);
  const invited = await get(provider, `/v1/me/invitations/${invitationId}`);
  await checked(
    await post(provider, `/v1/me/invitations/${invitationId}/respond`, {
      action: "ENGAGE",
      commandId: randomUUID(),
      expectedRevision: invited.revision,
    }),
    200,
  );
  const engaged = await get(provider, `/v1/me/invitations/${invitationId}`);
  const conversation = await get(
    provider,
    `/v1/me/invitations/${invitationId}/conversation`,
  );
  const quote = await checked(
    await post(
      provider,
      `/v1/me/conversations/${requiredString(conversation.id)}/quotes`,
      {
        authoringMode: "PLATFORM_STRUCTURED",
        commandId: randomUUID(),
        requestContentRevision: engaged.requestContentRevision,
        requestVisibleVersion: engaged.requestVisibleVersion,
      },
    ),
    201,
  );
  if (!record(quote.quote)) throw new Error("Synthetic quote missing");
  const quoteId = requiredString(quote.quote.id);
  await checked(
    await post(provider, `/v1/me/quotes/${quoteId}/revisions/1/structured`, {
      commandId: randomUUID(),
      expectedContentRevision: 0,
      content: {
        components: {},
        conditionalOnInspection: false,
        currency: "EUR",
        materialResponsibility: "PROVIDER",
        priceBasis: "Cena za syntetické práce.",
        priceMode: "FIXED",
        summary: "Samostatná syntetická ponuka na overenie dokončenia.",
        title: "Syntetická ponuka na overenie dokončenia",
        totalAmountCents: 120000,
        vatStatus: "VAT_INCLUDED",
      },
    }),
    200,
  );
  const draftQuote = await get(provider, `/v1/me/quotes/${quoteId}`);
  if (!record(draftQuote.currentDraft))
    throw new Error("Synthetic quote draft missing");
  await checked(
    await post(provider, `/v1/me/quotes/${quoteId}/revisions/1/submit`, {
      commandId: randomUUID(),
      expectedDraftStateRevision: draftQuote.currentDraft.stateRevision,
      expectedSubmittedStateRevision: null,
    }),
    200,
  );
  const submitted = await get(
    customer,
    `/v1/me/quotes/${quoteId}/lifecycle?quoteRevision=1`,
  );
  const accepted = await checked(
    await post(
      customer,
      `/v1/me/job-requests/${requestId}/quotes/${quoteId}/accept`,
      {
        commandId: randomUUID(),
        explicitlyConfirmed: true,
        expectedQuoteStateRevision: submitted.stateRevision,
        expectedRequestContentRevision: engaged.requestContentRevision,
        expectedRequestVisibleVersion: engaged.requestVisibleVersion,
        quoteRevision: 1,
        finalExactAddress: "Syntetická 47",
      },
    ),
    201,
  );
  const jobId = requiredString(accepted.jobId);
  expect(
    (
      await checked(
        await post(provider, `/v1/me/jobs/${jobId}/start`, {
          commandId: randomUUID(),
        }),
        201,
      )
    ).state,
  ).toBe("IN_PROGRESS");
  return jobId;
}

interface Actor {
  readonly context: BrowserContext;
  readonly csrfToken: string;
}
async function authenticated(
  browser: Browser,
  role: "CUSTOMER_A" | "CUSTOMER_B" | "PROVIDER_B",
): Promise<Actor> {
  const baseURL = requiredEnv("STAGING_E2E_BASE_URL");
  const context = await browser.newContext({
    baseURL,
    storageState: requiredEnv(
      role === "CUSTOMER_A"
        ? "STAGING_E2E_CUSTOMER_AUTH_STATE"
        : `STAGING_E2E_${role}_AUTH_STATE`,
    ),
    httpCredentials: {
      origin: baseURL,
      username: requiredEnv("STAGING_E2E_BASIC_AUTH_USERNAME"),
      password: requiredEnv("STAGING_E2E_BASIC_AUTH_PASSWORD"),
    },
  });
  const session = await get({ context, csrfToken: "" }, "/v1/auth/session");
  return { context, csrfToken: requiredString(session.csrfToken) };
}
const get = async (actor: Actor, path: string) =>
  checked(await actor.context.request.get(path), 200);
const post = (actor: Actor, path: string, data: unknown) =>
  actor.context.request.post(path, {
    data,
    headers: { "x-csrf-token": actor.csrfToken },
  });
async function checked(response: APIResponse, status: number) {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as Record<string, unknown>;
}
function agreement(job: Record<string, unknown>) {
  return { acceptedAt: job.acceptedAt, request: job.request, quote: job.quote };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Required synthetic response field missing");
  return value;
}
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing synthetic E2E input ${name}`);
  return value;
}
