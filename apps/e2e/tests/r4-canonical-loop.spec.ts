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
  test.setTimeout(480_000);
  test.skip(browserName !== "chromium", "One synthetic mutation is sufficient");

  const customer = await registerVerifiedSyntheticCustomer(browser);
  const provider = await authenticateSeededActor(browser, "PROVIDER_B");
  const competitor = await authenticateSeededActor(browser, "PROVIDER_A");
  try {
    const search = await get(
      customer,
      "/v1/public/craftsmen/search?professionCode=PROF%3AALPHA_SYNTHETIC",
    );
    const profiles = array(search["items"], "search results");
    const selectedProfileId = profileId(profiles, "Syntetická dielňa Beta");
    const alternateProfileId = profileId(profiles, "Testovací remeselník Alfa");
    const initialVerifiedWork = verifiedWorkEvidence(
      await get(customer, `/v1/public/craftsmen/${selectedProfileId}`),
    );

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

    const winningInvitation = await engageInvitation(
      customer,
      provider,
      requestId,
      selectedProfileId,
    );
    const losingInvitation = await engageInvitation(
      customer,
      competitor,
      requestId,
      alternateProfileId,
    );

    const contactCanary = "contact-probe@portal.invalid";
    const blockedContact = await provider.context.request.post(
      `/v1/me/conversations/${winningInvitation.conversationId}/messages`,
      {
        data: { body: contactCanary, commandId: randomUUID() },
        headers: { "x-csrf-token": provider.csrfToken },
      },
    );
    expect(blockedContact.status()).toBe(422);
    expect(await blockedContact.json()).toEqual({
      code: "CONTACT_SHARING_NOT_AVAILABLE",
    });

    const message = await post(
      provider,
      `/v1/me/conversations/${winningInvitation.conversationId}/messages`,
      {
        body: `Syntetický podklad ${alphabeticLabel()}`,
        commandId: randomUUID(),
      },
      201,
    );
    const messageId = requiredString(
      record(message["entry"], "conversation entry")["id"],
      "message ID",
    );
    const uploaded = await provider.context.request.post(
      `/v1/me/conversations/${winningInvitation.conversationId}/messages/${messageId}/attachments/documents`,
      {
        data: Buffer.from(minimalPdf()),
        headers: {
          "content-type": "application/pdf",
          "x-csrf-token": provider.csrfToken,
        },
      },
    );
    const upload = await checked(uploaded, 202, "private PDF upload");
    const mediaAssetId = requiredString(upload["assetId"], "media asset ID");
    await waitForReadyAttachment(
      provider,
      winningInvitation.conversationId,
      mediaAssetId,
    );
    const winningTimeline = await get(
      provider,
      `/v1/me/conversations/${winningInvitation.conversationId}/timeline?limit=50`,
    );
    expect(JSON.stringify(winningTimeline)).not.toContain(contactCanary);
    expect(
      (
        await competitor.context.request.get(
          `/v1/me/conversations/${winningInvitation.conversationId}/timeline?limit=50`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await customer.context.request.get(
          `/v1/media/${mediaAssetId}/download`,
          { maxRedirects: 0 },
        )
      ).status(),
    ).toBe(303);
    expect(
      (
        await competitor.context.request.get(
          `/v1/media/${mediaAssetId}/download`,
          { maxRedirects: 0 },
        )
      ).status(),
    ).toBe(404);

    const winningQuote = await submitExternalPdfQuote(
      provider,
      winningInvitation,
      120_000,
    );
    const losingQuote = await submitStructuredQuote(
      competitor,
      losingInvitation,
      "A",
      175_000,
    );
    const comparisonPath = `/v1/me/job-requests/${requestId}/quote-comparison`;
    const comparison = await get(customer, comparisonPath);
    const compared = array(comparison["items"], "Quote comparison");
    expect(compared).toHaveLength(2);
    expect(
      compared.map((item) => record(item, "comparison item")["quoteId"]).sort(),
    ).toEqual([winningQuote.quoteId, losingQuote.quoteId].sort());
    expect(
      compared
        .map(
          (item) =>
            record(
              record(item, "comparison item")["price"],
              "comparison price",
            )["totalAmountCents"],
        )
        .sort(),
    ).toEqual([120_000, 175_000]);
    const winningComparison = compared.find(
      (item) => recordOrNull(item)?.["quoteId"] === winningQuote.quoteId,
    );
    expect(record(winningComparison, "winning Quote comparison")).toMatchObject(
      {
        authoringMode: "EXTERNAL_PDF",
        pdfDownloadPath: `/v1/media/${winningQuote.pdfAssetId}/download`,
      },
    );
    expect(
      (await competitor.context.request.get(comparisonPath)).status(),
    ).toBe(404);

    const submitted = await get(
      customer,
      `/v1/me/quotes/${winningQuote.quoteId}/lifecycle?quoteRevision=1`,
    );
    const acceptanceCommand = {
      commandId: randomUUID(),
      explicitlyConfirmed: true,
      expectedQuoteStateRevision: submitted["stateRevision"],
      expectedRequestContentRevision: winningInvitation.requestContentRevision,
      expectedRequestVisibleVersion: winningInvitation.requestVisibleVersion,
      finalExactAddress: "Syntetická 47",
      quoteRevision: 1,
    };
    const acceptancePath = `/v1/me/job-requests/${requestId}/quotes/${winningQuote.quoteId}/accept`;
    const accepted = await post(
      customer,
      acceptancePath,
      acceptanceCommand,
      201,
    );
    expect(accepted["status"]).toBe("APPLIED");
    const jobId = requiredString(accepted["jobId"], "Job ID");
    const replay = await post(customer, acceptancePath, acceptanceCommand, 200);
    expect(replay["status"]).toBe("DEDUPLICATED");
    expect(replay["jobId"]).toBe(jobId);
    const competingAcceptance = await customer.context.request.post(
      `/v1/me/job-requests/${requestId}/quotes/${losingQuote.quoteId}/accept`,
      {
        data: { ...acceptanceCommand, commandId: randomUUID() },
        headers: { "x-csrf-token": customer.csrfToken },
      },
    );
    expect(competingAcceptance.status()).toBe(409);
    const losingState = await get(
      competitor,
      `/v1/me/invitations/${losingInvitation.invitationId}`,
    );
    expect(losingState["state"]).toBe("NOT_SELECTED");
    const ownedJobs = await get(customer, "/v1/me/jobs");
    expect(
      array(ownedJobs["jobs"], "owned Jobs").filter(
        (item) => recordOrNull(item)?.["id"] === jobId,
      ),
    ).toHaveLength(1);
    const jobPath = `/v1/me/jobs/${jobId}`;
    const originalAgreement = agreement(await get(customer, jobPath));
    expect(
      record(originalAgreement.quote, "accepted Quote snapshot"),
    ).toMatchObject({
      authoringMode: "EXTERNAL_PDF",
      pdfDownloadPath: `/v1/media/${winningQuote.pdfAssetId}/download`,
      quoteId: winningQuote.quoteId,
      revision: 1,
    });
    expect(
      (
        await customer.context.request.get(
          `/v1/media/${winningQuote.pdfAssetId}/download`,
          { maxRedirects: 0 },
        )
      ).status(),
    ).toBe(303);
    expect(
      (
        await provider.context.request.get(
          `/v1/media/${winningQuote.pdfAssetId}/download`,
          { maxRedirects: 0 },
        )
      ).status(),
    ).toBe(303);
    expect(
      (
        await competitor.context.request.get(
          `/v1/media/${winningQuote.pdfAssetId}/download`,
          { maxRedirects: 0 },
        )
      ).status(),
    ).toBe(404);
    const contactPath = `${jobPath}/contacts`;
    const customerContacts = await get(customer, contactPath);
    expect(
      record(customerContacts["workLocation"], "work location")["exactAddress"],
    ).toBe("Syntetická 47");
    const providerContacts = await get(provider, contactPath);
    expect(
      record(providerContacts["workLocation"], "provider work location")[
        "exactAddress"
      ],
    ).toBe("Syntetická 47");
    expect((await competitor.context.request.get(contactPath)).status()).toBe(
      404,
    );
    expect((await competitor.context.request.get(jobPath)).status()).toBe(404);

    const started = await post(
      provider,
      `${jobPath}/start`,
      { commandId: randomUUID() },
      201,
    );
    expect(started["state"]).toBe("IN_PROGRESS");
    const documentationPath = `${jobPath}/documentation?category=DOCUMENT&limit=20`;
    const documentation = await get(customer, documentationPath);
    expect(
      array(documentation["items"], "Job documentation").find(
        (item) => recordOrNull(item)?.["mediaAssetId"] === mediaAssetId,
      ),
    ).toMatchObject({
      authorRole: "PRIMARY_PROVIDER",
      downloadPath: `/v1/media/${mediaAssetId}/download`,
      kind: "DOCUMENT",
      mediaAssetId,
      source: "WINNING_CONVERSATION",
      sourceMessageId: messageId,
    });
    expect(
      (await competitor.context.request.get(documentationPath)).status(),
    ).toBe(404);
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
    const completedWork = verifiedWorkEvidence(
      await get(customer, `/v1/public/craftsmen/${selectedProfileId}`),
    );
    expect(completedWork).toEqual({
      profession: initialVerifiedWork.profession + 1,
      total: initialVerifiedWork.total + 1,
    });

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
    await Promise.all([
      customer.context.close(),
      provider.context.close(),
      competitor.context.close(),
    ]);
  }
});

interface EngagedInvitation {
  readonly conversationId: string;
  readonly invitationId: string;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
}

async function engageInvitation(
  customer: AuthenticatedActor,
  provider: AuthenticatedActor,
  requestId: string,
  craftsmanProfileId: string,
): Promise<EngagedInvitation> {
  const invitation = await post(
    customer,
    `/v1/me/job-requests/${requestId}/invitations`,
    { commandId: randomUUID(), craftsmanProfileId },
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
  expect(engaged["state"]).toBe("ENGAGED");
  const conversation = await get(
    provider,
    `/v1/me/invitations/${invitationId}/conversation`,
  );
  return {
    conversationId: requiredString(conversation["id"], "conversation ID"),
    invitationId,
    requestContentRevision: requiredInteger(
      engaged["requestContentRevision"],
      "request content revision",
    ),
    requestVisibleVersion: requiredInteger(
      engaged["requestVisibleVersion"],
      "request visible version",
    ),
  };
}

async function submitStructuredQuote(
  provider: AuthenticatedActor,
  invitation: EngagedInvitation,
  label: string,
  totalAmountCents: number,
): Promise<{ readonly quoteId: string }> {
  const created = await post(
    provider,
    `/v1/me/conversations/${invitation.conversationId}/quotes`,
    {
      authoringMode: "PLATFORM_STRUCTURED",
      commandId: randomUUID(),
      requestContentRevision: invitation.requestContentRevision,
      requestVisibleVersion: invitation.requestVisibleVersion,
    },
    201,
  );
  const quoteId = requiredString(
    record(created["quote"], "quote")["id"],
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
        summary: `Syntetická ponuka ${label} pre úplný overený tok.`,
        title: `Syntetická D30 ponuka ${label}`,
        totalAmountCents,
        vatStatus: "VAT_INCLUDED",
      },
    },
    200,
  );
  const quote = await get(provider, `/v1/me/quotes/${quoteId}`);
  await post(
    provider,
    `/v1/me/quotes/${quoteId}/revisions/1/submit`,
    {
      commandId: randomUUID(),
      expectedDraftStateRevision: requiredInteger(
        record(quote["currentDraft"], "quote draft")["stateRevision"],
        "Quote state revision",
      ),
      expectedSubmittedStateRevision: null,
    },
    200,
  );
  return { quoteId };
}

async function submitExternalPdfQuote(
  provider: AuthenticatedActor,
  invitation: EngagedInvitation,
  totalAmountCents: number,
): Promise<{ readonly pdfAssetId: string; readonly quoteId: string }> {
  const created = await post(
    provider,
    `/v1/me/conversations/${invitation.conversationId}/quotes`,
    {
      authoringMode: "EXTERNAL_PDF",
      commandId: randomUUID(),
      requestContentRevision: invitation.requestContentRevision,
      requestVisibleVersion: invitation.requestVisibleVersion,
    },
    201,
  );
  const quoteId = requiredString(
    record(created["quote"], "quote")["id"],
    "quote ID",
  );
  const uploaded = await provider.context.request.post(
    `/v1/me/quotes/${quoteId}/revisions/1/external-pdf/document`,
    {
      data: Buffer.from(minimalPdf()),
      headers: {
        "content-type": "application/pdf",
        "x-csrf-token": provider.csrfToken,
      },
    },
  );
  const upload = await checked(uploaded, 202, "external Quote PDF upload");
  const pdfAssetId = requiredString(upload["assetId"], "Quote PDF asset ID");
  const saveCommandId = randomUUID();
  let saved = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await provider.context.request.post(
      `/v1/me/quotes/${quoteId}/revisions/1/external-pdf`,
      {
        data: {
          commandId: saveCommandId,
          envelope: {
            currency: "EUR",
            materialResponsibility: "PROVIDER",
            priceMode: "FIXED",
            providerConfirmedSummaryMatchesPdf: true,
            totalAmountCents,
            vatStatus: "VAT_INCLUDED",
          },
          expectedContentRevision: 0,
          pdfAssetId,
        },
        headers: { "x-csrf-token": provider.csrfToken },
      },
    );
    if (response.status() === 200) {
      const result = await checked(response, 200, "external Quote save");
      expect(["SAVED", "DEDUPLICATED"]).toContain(result["status"]);
      expect(
        record(result["revision"], "external Quote revision")[
          "pdfDownloadPath"
        ],
      ).toBe(`/v1/media/${pdfAssetId}/download`);
      saved = true;
      break;
    }
    if (response.status() !== 409) {
      throw new Error(
        `external Quote save failed with HTTP ${response.status()}`,
      );
    }
    const pending = record(
      (await response.json().catch(() => null)) as unknown,
      "external Quote pending response",
    );
    expect(pending["code"]).toBe("PDF_NOT_READY");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!saved)
    throw new Error("Synthetic Quote PDF did not reach READY in time");

  const quote = await get(provider, `/v1/me/quotes/${quoteId}`);
  await post(
    provider,
    `/v1/me/quotes/${quoteId}/revisions/1/submit`,
    {
      commandId: randomUUID(),
      expectedDraftStateRevision: requiredInteger(
        record(quote["currentDraft"], "quote draft")["stateRevision"],
        "Quote state revision",
      ),
      expectedSubmittedStateRevision: null,
    },
    200,
  );
  return { pdfAssetId, quoteId };
}

async function waitForReadyAttachment(
  provider: AuthenticatedActor,
  conversationId: string,
  mediaAssetId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const timeline = await get(
      provider,
      `/v1/me/conversations/${conversationId}/timeline?limit=50`,
    );
    const attachment = array(timeline["entries"], "conversation timeline")
      .flatMap((entry) => {
        const candidate = recordOrNull(entry);
        const attachments = candidate?.["attachments"];
        return Array.isArray(attachments) ? (attachments as unknown[]) : [];
      })
      .find((item) => recordOrNull(item)?.["assetId"] === mediaAssetId);
    const status = recordOrNull(attachment)?.["status"];
    if (status === "READY") return;
    if (status === "REJECTED") {
      throw new Error("Synthetic private PDF was rejected");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Synthetic private PDF did not reach READY in time");
}

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

function verifiedWorkEvidence(profile: Record<string, unknown>): {
  readonly profession: number;
  readonly total: number;
} {
  const trust = record(profile["trust"], "public trust evidence");
  const profession = array(profile["professions"], "public professions").find(
    (item) => recordOrNull(item)?.["code"] === "PROF:ALPHA_SYNTHETIC",
  );
  return {
    profession: requiredNonnegativeInteger(
      record(profession, "public profession")["verifiedJobCount"],
      "profession verified Job count",
    ),
    total: requiredNonnegativeInteger(
      trust["verifiedWorkCount"],
      "verified work count",
    ),
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

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Synthetic ${label} is invalid`);
  }
  return value as number;
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Synthetic ${label} is invalid`);
  }
  return value as number;
}

function minimalPdf(): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let pdf = "%PDF-1.7\n% synthetic canonical attachment\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += object;
  }
  const xref = encoder.encode(pdf).byteLength;
  pdf += "xref\n0 5\n0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function alphabeticLabel(): string {
  return randomUUID()
    .slice(0, 8)
    .replace(/[0-9]/gu, (digit) => String.fromCharCode(103 + Number(digit)));
}
