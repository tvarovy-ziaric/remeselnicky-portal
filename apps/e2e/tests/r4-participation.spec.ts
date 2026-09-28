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

test("participant invitation, bilateral skill evidence and privacy survive the public tunnel", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  test.skip(
    browserName !== "chromium",
    "One synthetic mutation run is sufficient",
  );
  const provider = await authenticated(browser, "PROVIDER_B");
  const participant = await authenticated(browser, "PROVIDER_A");
  const customer = await authenticated(browser, "CUSTOMER_B");
  try {
    const profiles = await read(
      provider.context,
      "/v1/public/craftsmen/search?professionCode=PROF%3AALPHA_SYNTHETIC",
    );
    const participantProfile = (
      profiles.items as Array<Record<string, unknown>>
    ).find(
      (item) =>
        (item.identity as Record<string, unknown>)?.primaryName ===
        "Testovací remeselník Alfa",
    );
    const providerProfile = (
      profiles.items as Array<Record<string, unknown>>
    ).find(
      (item) =>
        (item.identity as Record<string, unknown>)?.primaryName ===
        "Syntetická dielňa Beta",
    );
    const participantProfileId = requiredString(participantProfile?.profileId);
    const providerProfileId = requiredString(providerProfile?.profileId);
    const publicProfilePath = `/v1/public/craftsmen/${participantProfileId}`;
    const evidenceBefore = verifiedWorkEvidence(
      await read(customer.context, publicProfilePath),
    );
    const selectedJobId = await createSyntheticJob(
      customer,
      provider,
      providerProfileId,
    );
    const anonymous = await browser.newContext({
      baseURL: requiredEnv("STAGING_E2E_BASE_URL"),
      ...accessHeaders(requiredEnv("STAGING_E2E_BASE_URL")),
    });
    try {
      const denied = await anonymous.request.get(
        `/v1/me/jobs/${selectedJobId}/roster`,
      );
      expect(denied.status()).toBe(401);
    } finally {
      await anonymous.close();
    }

    const invited = await post(
      provider,
      `/v1/me/jobs/${selectedJobId}/participants`,
      { commandId: randomUUID(), craftsmanProfileId: participantProfileId },
      201,
    );
    const participantId = requiredString(invited.participantId);
    const pending = await read(
      participant.context,
      "/v1/me/job-participations/invitations?limit=50",
    );
    expect(
      (pending.items as Array<Record<string, unknown>>).some(
        (item) => item.participantId === participantId,
      ),
    ).toBe(true);
    expect(
      (
        await customer.context.request.get(
          `/v1/me/job-participations/${participantId}`,
        )
      ).status(),
    ).toBe(404);
    const invitationPage = await participant.context.newPage();
    expect(
      (
        await invitationPage.goto(`/ucasti/pozvanky/${participantId}`)
      )?.status(),
    ).toBe(200);
    await expect(
      invitationPage.getByRole("heading", { name: "Čaká na vaše rozhodnutie" }),
    ).toBeVisible();
    await invitationPage.close();

    await post(
      participant,
      `/v1/me/job-participations/${participantId}/decision`,
      { commandId: randomUUID(), decision: "ACCEPT" },
      201,
    );
    const customerRoster = await read(
      customer.context,
      `/v1/me/jobs/${selectedJobId}/roster?limit=50`,
    );
    expect(
      (customerRoster.participants as Array<Record<string, unknown>>).find(
        (item) => item.id === participantId,
      )?.state,
    ).toBe("ACCEPTED");
    const historyPage = await participant.context.newPage();
    expect(
      (await historyPage.goto(`/ucasti/historia/${participantId}`))?.status(),
    ).toBe(200);
    await expect(
      historyPage.getByRole("heading", { name: "Potvrdená účasť" }),
    ).toBeVisible();

    const confirmedRoleCommandId = randomUUID();
    await post(
      provider,
      `/v1/me/job-participations/${participantId}/roles`,
      {
        action: "ASSIGN",
        commandId: confirmedRoleCommandId,
        role: "LEAD",
      },
      201,
    );
    const correctionRoleCommandId = randomUUID();
    await post(
      provider,
      `/v1/me/job-participations/${participantId}/roles`,
      {
        action: "ASSIGN",
        commandId: correctionRoleCommandId,
        role: "SITE_MANAGER",
      },
      201,
    );
    const roleAssignmentsPath = `/v1/me/job-participations/${participantId}/role-assignments`;
    const pendingRoles = await read(participant.context, roleAssignmentsPath);
    const pendingRoleItems = pendingRoles.items as Array<
      Record<string, unknown>
    >;
    const confirmedRoleAssignmentId = requiredString(
      pendingRoleItems.find((item) => item.role === "LEAD")?.assignmentEventId,
    );
    const correctionRoleAssignmentId = requiredString(
      pendingRoleItems.find((item) => item.role === "SITE_MANAGER")
        ?.assignmentEventId,
    );
    expect(pendingRoles.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignmentEventId: confirmedRoleAssignmentId,
          role: "LEAD",
        }),
        expect.objectContaining({
          assignmentEventId: correctionRoleAssignmentId,
          role: "SITE_MANAGER",
        }),
      ]),
    );
    expect(
      (await customer.context.request.get(roleAssignmentsPath)).status(),
    ).toBe(404);
    await historyPage.reload({ waitUntil: "domcontentloaded" });
    const roleRegion = historyPage.getByRole("region", {
      name: "Potvrdenie rolí na zákazke",
    });
    const leadRole = roleRegion
      .getByText("Vedúci", { exact: true })
      .locator("..");
    await expect(leadRole.getByText("Vedúci", { exact: true })).toBeVisible();
    await leadRole.getByRole("button", { name: "Potvrdiť rolu" }).click();
    await expect(
      historyPage.getByRole("status").filter({
        hasText: "Rolu ste potvrdili",
      }),
    ).toBeVisible();
    await expect(roleRegion.getByText("Vedúci", { exact: true })).toHaveCount(
      0,
    );
    await post(
      participant,
      `${roleAssignmentsPath}/${correctionRoleAssignmentId}/decision`,
      {
        commandId: randomUUID(),
        decision: "REQUEST_CORRECTION",
        reason: "Túto rolu som na zákazke nevykonával.",
      },
      201,
    );
    expect(
      (await read(participant.context, roleAssignmentsPath)).items,
    ).toEqual([]);
    await historyPage.close();

    const collection = `/v1/me/job-participations/${participantId}/capabilities`;
    const proposal = await post(
      participant,
      collection,
      {
        commandId: randomUUID(),
        kind: "CUSTOM_SKILL",
        customSkillText: `Syntetická zručnosť ${randomUUID().slice(0, 8)}`,
      },
      201,
    );
    const claimId = requiredString(proposal.claimId);
    const providerClaims = await read(
      provider.context,
      `${collection}?limit=20`,
    );
    expect(providerClaims.canAct).toBe(true);
    expect(
      (providerClaims.items as Array<Record<string, unknown>>).find(
        (item) => item.claimId === claimId,
      )?.canConfirm,
    ).toBe(true);
    expect((await customer.context.request.get(collection)).status()).toBe(404);
    await post(
      provider,
      `${collection}/${claimId}/confirm`,
      { commandId: randomUUID() },
      200,
    );
    const confirmed = await read(participant.context, `${collection}?limit=20`);
    expect(
      (confirmed.items as Array<Record<string, unknown>>).find(
        (item) => item.claimId === claimId,
      )?.status,
    ).toBe("CONFIRMED");

    const professionProposal = await post(
      provider,
      collection,
      {
        commandId: randomUUID(),
        kind: "PROFESSION",
        professionCode: "PROF:ALPHA_SYNTHETIC",
      },
      201,
    );
    const professionClaimId = requiredString(professionProposal.claimId);
    await post(
      participant,
      `${collection}/${professionClaimId}/confirm`,
      { commandId: randomUUID() },
      200,
    );
    const capabilityPage = await participant.context.newPage();
    expect(
      (
        await capabilityPage.goto(`/ucasti/schopnosti/${participantId}`)
      )?.status(),
    ).toBe(200);
    await expect(
      capabilityPage.getByRole("heading", {
        name: "Profesie a zručnosti na zákazke",
      }),
    ).toBeVisible();
    await capabilityPage.close();

    expect(
      await read(
        participant.context,
        `/v1/me/job-participations/${participantId}`,
      ),
    ).toMatchObject({
      verifiedCompletedWork: false,
      verifiedProfessionCodes: [],
      verifiedRoles: [],
    });

    const jobPath = `/v1/me/jobs/${selectedJobId}`;
    expect(
      (
        await post(
          provider,
          `${jobPath}/start`,
          {
            commandId: randomUUID(),
          },
          201,
        )
      ).state,
    ).toBe("IN_PROGRESS");
    const completion = await post(
      provider,
      `${jobPath}/completion/request`,
      {
        commandId: randomUUID(),
        finalMediaAssetIds: [],
        note: "Syntetické dokončenie s overenou účasťou.",
      },
      201,
    );
    const attemptId = requiredString(completion.attemptId);
    expect(
      (
        await post(
          customer,
          `${jobPath}/completion/${attemptId}/accept`,
          { commandId: randomUUID() },
          201,
        )
      ).jobState,
    ).toBe("COMPLETED");

    const completedDetail = await read(
      participant.context,
      `/v1/me/job-participations/${participantId}`,
    );
    expect(completedDetail).toMatchObject({
      jobState: "COMPLETED",
      verifiedCompletedWork: true,
      verifiedProfessionCodes: expect.arrayContaining(["PROF:ALPHA_SYNTHETIC"]),
      verifiedRoles: expect.arrayContaining(["MEMBER", "LEAD"]),
    });
    expect(completedDetail.verifiedRoles).not.toContain("SITE_MANAGER");
    const completedPage = await participant.context.newPage();
    expect(
      (await completedPage.goto(`/ucasti/historia/${participantId}`))?.status(),
    ).toBe(200);
    await expect(
      completedPage.getByText(
        "Overená účasť na dokončenej zákazke. Nie je to hodnotenie kvality.",
      ),
    ).toBeVisible();
    await expect(
      completedPage.getByText("Vedúci", { exact: false }),
    ).toBeVisible();
    await completedPage.close();

    const publicProfileAfter = await read(customer.context, publicProfilePath);
    const serializedPublicProfile = JSON.stringify(publicProfileAfter);
    expect(serializedPublicProfile).not.toContain(selectedJobId);
    expect(serializedPublicProfile).not.toContain(participantId);
    const evidenceAfter = verifiedWorkEvidence(publicProfileAfter);
    expect(evidenceAfter.total).toBe(evidenceBefore.total + 1);
    expect(evidenceAfter.profession).toBe(evidenceBefore.profession + 1);
  } finally {
    await Promise.all([
      provider.context.close(),
      participant.context.close(),
      customer.context.close(),
    ]);
  }
});

interface Actor {
  readonly context: BrowserContext;
  readonly csrfToken: string;
}

async function createSyntheticJob(
  customer: Actor,
  provider: Actor,
  providerProfileId: string,
): Promise<string> {
  const request = await post(
    customer,
    "/v1/me/job-request-drafts",
    {
      commandId: randomUUID(),
      section: {
        key: "request.core",
        schemaVersion: 1,
        payload: {
          description: "Syntetická zákazka pre overenie individuálnej účasti.",
          primaryProfessionCode: "PROF:ALPHA_SYNTHETIC",
          relatedProfessionCodes: [],
          skillCodes: [],
          specializationCode: null,
          title: `Syntetická účasť ${randomUUID().slice(0, 8)}`,
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
  const invitation = await post(
    customer,
    `/v1/me/job-requests/${requestId}/invitations`,
    { commandId: randomUUID(), craftsmanProfileId: providerProfileId },
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
  const quote = await post(
    provider,
    `/v1/me/conversations/${requiredString(conversation.id)}/quotes`,
    {
      authoringMode: "PLATFORM_STRUCTURED",
      commandId: randomUUID(),
      requestContentRevision: engaged.requestContentRevision,
      requestVisibleVersion: engaged.requestVisibleVersion,
    },
    201,
  );
  const quoteId = requiredString((quote.quote as Record<string, unknown>).id);
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
        priceBasis: "Syntetická cena práce.",
        priceMode: "FIXED",
        summary: "Syntetická ponuka na overenie účasti",
        title: "Syntetická ponuka na overenie účasti",
        totalAmountCents: 125000,
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
  const submitted = await read(provider.context, `/v1/me/quotes/${quoteId}`);
  const currentSubmitted = submitted.currentSubmitted as Record<
    string,
    unknown
  >;
  const accepted = await post(
    customer,
    `/v1/me/job-requests/${requestId}/quotes/${quoteId}/accept`,
    {
      commandId: randomUUID(),
      explicitlyConfirmed: true,
      expectedQuoteStateRevision: currentSubmitted.stateRevision,
      expectedRequestContentRevision: currentSubmitted.requestContentRevision,
      expectedRequestVisibleVersion: currentSubmitted.requestVisibleVersion,
      finalExactAddress: "Syntetická 47",
      quoteRevision: currentSubmitted.revision,
    },
    201,
  );
  return requiredString(accepted.jobId);
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
  return checked(await context.request.get(path), 200);
}

async function post(
  actor: Actor,
  path: string,
  data: unknown,
  expected: number,
): Promise<Record<string, unknown>> {
  return checked(
    await actor.context.request.post(path, {
      data,
      headers: { "x-csrf-token": actor.csrfToken },
    }),
    expected,
  );
}

async function checked(
  response: APIResponse,
  expected: number,
): Promise<Record<string, unknown>> {
  expect(response.status(), await response.text()).toBe(expected);
  return (await response.json()) as Record<string, unknown>;
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

function verifiedWorkEvidence(profile: Record<string, unknown>): {
  readonly profession: number;
  readonly total: number;
} {
  const trust = object(profile.trust);
  const profession = (profile.professions as unknown[]).find(
    (item) => object(item).code === "PROF:ALPHA_SYNTHETIC",
  );
  return {
    profession: nonnegativeInteger(object(profession).verifiedJobCount),
    total: nonnegativeInteger(trust.verifiedWorkCount),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Synthetic public evidence is invalid");
  return value as Record<string, unknown>;
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error("Synthetic public evidence count is invalid");
  return value;
}
