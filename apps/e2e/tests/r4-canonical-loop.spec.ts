import { randomUUID } from "node:crypto";

import { expect, test, type APIResponse } from "@playwright/test";

import {
  authenticateSeededActor,
  registerVerifiedSyntheticCustomer,
  type AuthenticatedActor,
} from "./support/synthetic-registration.js";

test.skip(
  process.env["STAGING_E2E_CANONICAL_ENABLED"] !== "true",
  "D30 synthetic registration and verification sink are not provisioned",
);

test("fresh verified customer recovers a draft, shortlists a provider and completes the canonical loop", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(360_000);
  test.skip(browserName !== "chromium", "One synthetic mutation is sufficient");

  const customer = await registerVerifiedSyntheticCustomer(browser);
  const provider = await authenticateSeededActor(browser, "PROVIDER_B");
  try {
    const search = await get(
      customer,
      "/v1/public/craftsmen/search?professionCode=PROF%3AALPHA_SYNTHETIC",
    );
    const profiles = array(search["items"], "search results");
    const selectedProfileId = profileId(profiles, "Syntetická dielňa Beta");
    const alternateProfileId = profileId(profiles, "Testovací remeselník Alfa");

    const draft = await post(
      customer,
      "/v1/me/job-request-drafts",
      {
        commandId: randomUUID(),
        section: {
          key: "request.core",
          schemaVersion: 1,
          payload: {
            description:
              "Syntetický dopyt čerstvo registrovaného a overeného zákazníka.",
            primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
            relatedProfessionCodes: [],
            skillCodes: [],
            specializationCode: null,
            title: `Syntetický D30 dopyt ${alphabeticLabel()}`,
          },
        },
      },
      201,
    );
    const requestId = requiredString(draft["id"], "request ID");
    const located = await post(
      customer,
      `/v1/me/job-request-drafts/${requestId}/sections`,
      {
        commandId: randomUUID(),
        expectedRevision: draft["revision"],
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

    const recovered = record(
      (await get(customer, `/v1/me/job-request-drafts/${requestId}`))["draft"],
      "recovered draft",
    );
    expect(recovered["id"]).toBe(requestId);
    expect(recovered["revision"]).toBe(located["revision"]);
    expect(JSON.stringify(recovered["sections"])).toContain(
      "TEST:MUNICIPALITY_ALPHA",
    );

    await post(
      customer,
      `/v1/me/job-request-drafts/${requestId}/activate`,
      { commandId: randomUUID(), expectedRevision: located["revision"] },
      200,
    );

    for (const craftsmanProfileId of [selectedProfileId, alternateProfileId]) {
      noContent(
        await customer.context.request.post("/v1/me/shortlist/add", {
          data: { commandId: randomUUID(), craftsmanProfileId },
          headers: { "x-csrf-token": customer.csrfToken },
        }),
        204,
        "shortlist add",
      );
    }
    const shortlist = await get(customer, "/v1/me/shortlist");
    const shortlistedIds = array(shortlist["items"], "shortlist").map((item) =>
      requiredString(
        record(item, "shortlist entry")["craftsmanProfileId"],
        "shortlist profile ID",
      ),
    );
    expect(shortlistedIds).toEqual(
      expect.arrayContaining([selectedProfileId, alternateProfileId]),
    );

    const invitation = await post(
      customer,
      `/v1/me/job-requests/${requestId}/invitations`,
      { commandId: randomUUID(), craftsmanProfileId: selectedProfileId },
      201,
    );
    const invitationId = requiredString(invitation["id"], "invitation ID");
    const pending = await get(provider, `/v1/me/invitations/${invitationId}`);
    await post(
      provider,
      `/v1/me/invitations/${invitationId}/respond`,
      {
        action: "ENGAGE",
        commandId: randomUUID(),
        expectedRevision: pending["revision"],
      },
      200,
    );
    const engaged = await get(provider, `/v1/me/invitations/${invitationId}`);
    const conversation = await get(
      provider,
      `/v1/me/invitations/${invitationId}/conversation`,
    );
    const conversationId = requiredString(
      conversation["id"],
      "conversation ID",
    );
    const quote = await post(
      provider,
      `/v1/me/conversations/${conversationId}/quotes`,
      {
        authoringMode: "PLATFORM_STRUCTURED",
        commandId: randomUUID(),
        requestContentRevision: engaged["requestContentRevision"],
        requestVisibleVersion: engaged["requestVisibleVersion"],
      },
      201,
    );
    const quoteId = requiredString(
      record(quote["quote"], "quote")["id"],
      "quote ID",
    );
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
          summary: "Syntetická ponuka pre úplný overený tok.",
          title: "Syntetická D30 ponuka",
          totalAmountCents: 120_000,
          vatStatus: "VAT_INCLUDED",
        },
      },
      200,
    );
    const draftQuote = await get(provider, `/v1/me/quotes/${quoteId}`);
    await post(
      provider,
      `/v1/me/quotes/${quoteId}/revisions/1/submit`,
      {
        commandId: randomUUID(),
        expectedDraftStateRevision: record(
          draftQuote["currentDraft"],
          "quote draft",
        )["stateRevision"],
        expectedSubmittedStateRevision: null,
      },
      200,
    );
    const submitted = await get(
      customer,
      `/v1/me/quotes/${quoteId}/lifecycle?quoteRevision=1`,
    );
    const accepted = await post(
      customer,
      `/v1/me/job-requests/${requestId}/quotes/${quoteId}/accept`,
      {
        commandId: randomUUID(),
        explicitlyConfirmed: true,
        expectedQuoteStateRevision: submitted["stateRevision"],
        expectedRequestContentRevision: engaged["requestContentRevision"],
        expectedRequestVisibleVersion: engaged["requestVisibleVersion"],
        finalExactAddress: "Syntetická 47",
        quoteRevision: 1,
      },
      201,
    );
    const jobId = requiredString(accepted["jobId"], "Job ID");
    const jobPath = `/v1/me/jobs/${jobId}`;
    const originalAgreement = agreement(await get(customer, jobPath));

    const started = await post(
      provider,
      `${jobPath}/start`,
      { commandId: randomUUID() },
      201,
    );
    expect(started["state"]).toBe("IN_PROGRESS");
    const completionPath = `${jobPath}/completion`;
    const completion = await post(
      provider,
      `${completionPath}/request`,
      {
        commandId: randomUUID(),
        finalMediaAssetIds: [],
        note: "Syntetické odovzdanie po dokončení.",
      },
      201,
    );
    const attemptId = requiredString(
      completion["attemptId"],
      "completion attempt ID",
    );
    const completed = await post(
      customer,
      `${completionPath}/${attemptId}/accept`,
      { commandId: randomUUID() },
      201,
    );
    expect(completed["jobState"]).toBe("COMPLETED");
    const finalJob = await get(customer, jobPath);
    expect(finalJob["state"]).toBe("COMPLETED");
    expect(agreement(finalJob)).toEqual(originalAgreement);

    const reviewPath = `${jobPath}/reviews/main`;
    const customerOpportunity = await get(customer, reviewPath);
    expect(customerOpportunity).toMatchObject({
      direction: "CUSTOMER_TO_PROVIDER",
      state: "OPEN",
    });
    const providerProfileId = requiredString(
      customerOpportunity["targetProfileId"],
      "review target profile ID",
    );
    const customerReviewId = randomUUID();
    await post(
      customer,
      reviewPath,
      {
        commandId: customerReviewId,
        expectedVersion: 0,
        ratings: {
          work_quality: 5,
          price_adherence: 5,
          schedule_adherence: 4,
          communication: 5,
          cleanliness: 5,
          problem_solving: 4,
          would_hire_again: 5,
        },
        comment: "Syntetická zákazka bola riadne dokončená.",
      },
      201,
    );
    expect(await get(customer, reviewPath)).toMatchObject({
      state: "SUBMITTED_SEALED",
      counterpartyReview: null,
    });
    const providerReviewId = randomUUID();
    await post(
      provider,
      reviewPath,
      {
        commandId: providerReviewId,
        expectedVersion: 0,
        ratings: {
          agreement_payment_experience: 5,
          site_readiness: 4,
          brief_clarity: 5,
          communication: 5,
          unplanned_changes: 4,
          fairness: 5,
        },
        comment: "Syntetická spolupráca prebehla korektne.",
      },
      201,
    );
    expect(await get(customer, reviewPath)).toMatchObject({
      state: "UNLOCKED",
      counterpartyReview: { revisionId: providerReviewId },
      ownReview: { revisionId: customerReviewId },
    });
    const publicReviews = await get(
      customer,
      `/v1/public/craftsmen/${providerProfileId}/reviews?limit=20`,
    );
    expect(array(publicReviews["reviews"], "public reviews")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewId: customerReviewId }),
      ]),
    );
  } finally {
    await Promise.all([customer.context.close(), provider.context.close()]);
  }
});

async function get(
  actor: AuthenticatedActor,
  path: string,
): Promise<Record<string, unknown>> {
  return checked(await actor.context.request.get(path), 200, "read");
}

async function post(
  actor: AuthenticatedActor,
  path: string,
  data: unknown,
  status: number,
): Promise<Record<string, unknown>> {
  return checked(
    await actor.context.request.post(path, {
      data,
      headers: { "x-csrf-token": actor.csrfToken },
    }),
    status,
    "command",
  );
}

async function checked(
  response: APIResponse,
  status: number,
  operation: string,
): Promise<Record<string, unknown>> {
  if (response.status() !== status) {
    throw new Error(`${operation} failed with HTTP ${response.status()}`);
  }
  const body = (await response.json().catch(() => null)) as unknown;
  return record(body, `${operation} response`);
}

function noContent(
  response: APIResponse,
  status: number,
  operation: string,
): void {
  if (response.status() !== status) {
    throw new Error(`${operation} failed with HTTP ${response.status()}`);
  }
}

function profileId(items: readonly unknown[], name: string): string {
  const matches = items.filter((item) => {
    const candidate = recordOrNull(item);
    const identity = recordOrNull(candidate?.["identity"]);
    return identity?.["primaryName"] === name;
  });
  expect(matches).toHaveLength(1);
  return requiredString(
    record(matches[0], "search result")["profileId"],
    "profile ID",
  );
}

function agreement(job: Record<string, unknown>) {
  return {
    acceptedAt: job["acceptedAt"],
    request: job["request"],
    quote: job["quote"],
  };
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Synthetic ${label} is invalid`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  const candidate = recordOrNull(value);
  if (candidate === null) throw new Error(`Synthetic ${label} is invalid`);
  return candidate;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Synthetic ${label} is unavailable`);
  }
  return value;
}

function alphabeticLabel(): string {
  return randomUUID()
    .slice(0, 8)
    .replace(/[0-9]/gu, (digit) => String.fromCharCode(103 + Number(digit)));
}
