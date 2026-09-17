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
  "Synthetic Quick Tunnel Alpha is not provisioned",
);

test("change-order draft, exact counterproposal and approval preserve the original agreement", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  test.skip(
    browserName !== "chromium",
    "One synthetic mutation run is sufficient",
  );
  const customer = await authenticated(browser, "CUSTOMER_B");
  const provider = await authenticated(browser, "PROVIDER_B");
  const outsider = await authenticated(browser, "CUSTOMER_A");
  try {
    const jobId = await sharedOpenJob(customer, provider);
    const jobPath = `/v1/me/jobs/${jobId}`;
    const original = agreement(
      await checked(await customer.context.request.get(jobPath), 200),
    );
    const collection = `${jobPath}/change-orders`;
    const title = `Syntetická zmena ${randomUUID().slice(0, 8)}`;
    const createId = randomUUID(),
      firstRevisionId = randomUUID();
    const firstTerms = terms(title, "Zákazník žiada ďalšiu montáž.");
    const created = await checked(
      await post(customer, collection, {
        commandId: createId,
        revisionId: firstRevisionId,
        terms: firstTerms,
      }),
      201,
    );
    expect(created).toMatchObject({
      status: "APPLIED",
      changeOrderId: createId,
      revisionId: firstRevisionId,
      revisionNumber: 1,
      state: "DRAFT",
    });
    const detailPath = `${collection}/${createId}`;
    const firstPath = `${detailPath}/revisions/${firstRevisionId}`;
    expect(
      (await checked(await customer.context.request.get(firstPath), 200)).state,
    ).toBe("DRAFT");
    expect((await provider.context.request.get(detailPath)).status()).toBe(404);
    expect((await provider.context.request.get(firstPath)).status()).toBe(404);
    expect(
      JSON.stringify(
        await checked(await provider.context.request.get(collection), 200),
      ),
    ).not.toContain(title);
    expect((await outsider.context.request.get(collection)).status()).toBe(404);
    expect((await outsider.context.request.get(firstPath)).status()).toBe(404);
    expect(
      (
        await post(provider, `${detailPath}/propose`, {
          commandId: randomUUID(),
          revisionId: firstRevisionId,
          revisionNumber: 1,
        })
      ).status(),
    ).toBe(404);
    expect(
      agreement(
        await checked(await customer.context.request.get(jobPath), 200),
      ),
    ).toEqual(original);

    const proposed = await checked(
      await post(customer, `${detailPath}/propose`, {
        commandId: randomUUID(),
        revisionId: firstRevisionId,
        revisionNumber: 1,
      }),
      200,
    );
    expect(proposed).toMatchObject({
      revisionId: firstRevisionId,
      revisionNumber: 1,
      state: "PROPOSED",
    });
    const offered = await checked(
      await provider.context.request.get(firstPath),
      200,
    );
    expect(offered).toMatchObject({
      revisionId: firstRevisionId,
      state: "PROPOSED",
      terms: { title },
    });
    expect(
      agreement(
        await checked(await customer.context.request.get(jobPath), 200),
      ),
    ).toEqual(original);
    const page = await provider.context.newPage();
    expect(
      (
        await page.goto(
          `/zakazky/${jobId}/zmeny/${createId}/revizie/${firstRevisionId}`,
        )
      )?.status(),
    ).toBe(200);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const nextTerms = terms(
      `${title} · protinávrh`,
      "Poskytovateľ navrhuje upravený rozsah.",
    );
    const counterId = randomUUID();
    const counter = await checked(
      await post(provider, `${detailPath}/counterpropose`, {
        commandId: counterId,
        expectedRevisionId: firstRevisionId,
        terms: nextTerms,
      }),
      200,
    );
    expect(counter).toMatchObject({
      revisionId: counterId,
      revisionNumber: 2,
      state: "PROPOSED",
    });
    const exactCounter = await checked(
      await customer.context.request.get(
        `${detailPath}/revisions/${counterId}`,
      ),
      200,
    );
    expect(exactCounter).toMatchObject({
      revisionId: counterId,
      revisionNumber: 2,
      terms: { title: nextTerms.title },
    });
    expect(
      (
        await post(provider, `${detailPath}/counterpropose`, {
          commandId: randomUUID(),
          expectedRevisionId: firstRevisionId,
          terms: nextTerms,
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await post(provider, `${detailPath}/approve`, {
          commandId: randomUUID(),
          revisionId: firstRevisionId,
          revisionNumber: 1,
        })
      ).status(),
    ).toBe(409);
    expect(
      agreement(
        await checked(await customer.context.request.get(jobPath), 200),
      ),
    ).toEqual(original);
    const approvalId = randomUUID();
    const approved = await checked(
      await post(customer, `${detailPath}/approve`, {
        commandId: approvalId,
        revisionId: counterId,
        revisionNumber: 2,
      }),
      200,
    );
    expect(approved).toMatchObject({
      revisionId: counterId,
      revisionNumber: 2,
      state: "APPROVED",
    });
    const replay = await checked(
      await post(customer, `${detailPath}/approve`, {
        commandId: approvalId,
        revisionId: counterId,
        revisionNumber: 2,
      }),
      200,
    );
    expect(replay.status).toBe("DEDUPLICATED");
    expect(
      (
        await post(customer, `${detailPath}/approve`, {
          commandId: randomUUID(),
          revisionId: counterId,
          revisionNumber: 2,
        })
      ).status(),
    ).toBe(409);
    expect(
      (await checked(await customer.context.request.get(detailPath), 200))
        .revisions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revisionId: counterId, state: "APPROVED" }),
      ]),
    );
    expect(
      agreement(
        await checked(await customer.context.request.get(jobPath), 200),
      ),
    ).toEqual(original);
    expect((await outsider.context.request.get(detailPath)).status()).toBe(404);
  } finally {
    await Promise.all([
      customer.context.close(),
      provider.context.close(),
      outsider.context.close(),
    ]);
  }
});

test("rejected revision cannot be approved, and competitor cannot bind a change", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  test.skip(
    browserName !== "chromium",
    "One synthetic mutation run is sufficient",
  );
  const customer = await authenticated(browser, "CUSTOMER_B"),
    provider = await authenticated(browser, "PROVIDER_B"),
    outsider = await authenticated(browser, "CUSTOMER_A");
  try {
    const jobId = await sharedOpenJob(customer, provider),
      collection = `/v1/me/jobs/${jobId}/change-orders`;
    const commandId = randomUUID(),
      revisionId = randomUUID();
    const created = await checked(
      await post(provider, collection, {
        commandId,
        revisionId,
        terms: terms(
          `Syntetické odmietnutie ${randomUUID().slice(0, 8)}`,
          "Návrh na odmietnutie.",
        ),
      }),
      201,
    );
    expect(created.state).toBe("DRAFT");
    const detail = `${collection}/${commandId}`;
    expect(
      (
        await post(outsider, `${detail}/propose`, {
          commandId: randomUUID(),
          revisionId,
          revisionNumber: 1,
        })
      ).status(),
    ).toBe(404);
    await checked(
      await post(provider, `${detail}/propose`, {
        commandId: randomUUID(),
        revisionId,
        revisionNumber: 1,
      }),
      200,
    );
    const rejected = await checked(
      await post(customer, `${detail}/reject`, {
        commandId: randomUUID(),
        revisionId,
        revisionNumber: 1,
      }),
      200,
    );
    expect(rejected.state).toBe("REJECTED");
    expect(
      (
        await post(customer, `${detail}/approve`, {
          commandId: randomUUID(),
          revisionId,
          revisionNumber: 1,
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await outsider.context.request.get(`${detail}/revisions/${revisionId}`)
      ).status(),
    ).toBe(404);
  } finally {
    await Promise.all([
      customer.context.close(),
      provider.context.close(),
      outsider.context.close(),
    ]);
  }
});

test("provider PDF addendum is bound only after READY and delivered only to its Job parties", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(210_000);
  test.skip(
    browserName !== "chromium",
    "One synthetic mutation run is sufficient",
  );
  const customer = await authenticated(browser, "CUSTOMER_B");
  const provider = await authenticated(browser, "PROVIDER_B");
  const outsider = await authenticated(browser, "CUSTOMER_A");
  try {
    const jobId = await sharedOpenJob(customer, provider);
    const collection = `/v1/me/jobs/${jobId}/change-orders`;
    const changeOrderId = randomUUID(),
      revisionId = randomUUID();
    const reservationPath = `/v1/me/jobs/${jobId}/change-order-pdf-reservations`;
    const reservation = await checked(
      await post(provider, reservationPath, {
        commandId: changeOrderId,
        changeOrderId,
        revisionId,
        expectedRevisionId: null,
      }),
      201,
    );
    expect(reservation).toMatchObject({
      status: "AUTHORIZED",
      reservationId: changeOrderId,
      revisionNumber: 1,
    });
    expect(
      (
        await post(customer, reservationPath, {
          commandId: randomUUID(),
          changeOrderId: randomUUID(),
          revisionId: randomUUID(),
          expectedRevisionId: null,
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await post(outsider, reservationPath, {
          commandId: randomUUID(),
          changeOrderId: randomUUID(),
          revisionId: randomUUID(),
          expectedRevisionId: null,
        })
      ).status(),
    ).toBe(404);
    const upload = await provider.context.request.post(
      `/v1/me/jobs/${jobId}/change-order-revisions/${revisionId}/pdf`,
      {
        data: Buffer.from(minimalPdf()),
        headers: {
          "content-type": "application/pdf",
          "x-csrf-token": provider.csrfToken,
        },
      },
    );
    const uploaded = await checked(upload, 202);
    expect(uploaded.status).toBe("PROCESSING");
    const assetId = requiredString(uploaded.assetId);
    const statusPath = `/v1/me/jobs/${jobId}/change-order-revisions/${revisionId}/pdf/${assetId}/status`;
    expect((await customer.context.request.get(statusPath)).status()).toBe(404);
    expect((await outsider.context.request.get(statusPath)).status()).toBe(404);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await checked(
        await provider.context.request.get(statusPath),
        200,
      );
      if (status.status === "READY") {
        expect(status.canCreateRevision).toBe(true);
        ready = true;
        break;
      }
      expect(status.status).toBe("PROCESSING");
      expect(status.canCreateRevision).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(ready, "Synthetic PDF processing did not reach READY").toBe(true);
    const title = `Syntetický PDF dodatok ${randomUUID().slice(0, 8)}`;
    const created = await checked(
      await post(provider, collection, {
        commandId: changeOrderId,
        revisionId,
        terms: {
          ...terms(title, "Zmena s autoritatívnym PDF."),
          externalPdfMediaAssetId: assetId,
        },
      }),
      201,
    );
    expect(created).toMatchObject({
      changeOrderId,
      revisionId,
      state: "DRAFT",
    });
    const revisionPath = `${collection}/${changeOrderId}/revisions/${revisionId}`;
    const draft = await checked(
      await provider.context.request.get(revisionPath),
      200,
    );
    const draftTerms = asRecord(draft.terms);
    expect(draftTerms.externalPdfDownloadPath).toBe(
      `/v1/media/${assetId}/download`,
    );
    expect((await customer.context.request.get(revisionPath)).status()).toBe(
      404,
    );
    expect(
      (
        await outsider.context.request.get(`/v1/media/${assetId}/download`, {
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(404);
    await checked(
      await post(provider, `${collection}/${changeOrderId}/propose`, {
        commandId: randomUUID(),
        revisionId,
        revisionNumber: 1,
      }),
      200,
    );
    const visible = await checked(
      await customer.context.request.get(revisionPath),
      200,
    );
    expect(asRecord(visible.terms).externalPdfDownloadPath).toBe(
      `/v1/media/${assetId}/download`,
    );
    const authorized = await customer.context.request.get(
      `/v1/media/${assetId}/download`,
      { maxRedirects: 0 },
    );
    expect(authorized.status()).toBe(303);
    expect((await outsider.context.request.get(revisionPath)).status()).toBe(
      404,
    );
    expect(
      (
        await outsider.context.request.get(`/v1/media/${assetId}/download`, {
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await Promise.all([
      customer.context.close(),
      provider.context.close(),
      outsider.context.close(),
    ]);
  }
});

interface Actor {
  readonly context: BrowserContext;
  readonly csrfToken: string;
}
type Role = "CUSTOMER_A" | "CUSTOMER_B" | "PROVIDER_B";
async function authenticated(browser: Browser, role: Role): Promise<Actor> {
  const baseURL = requiredEnv("STAGING_E2E_BASE_URL");
  const context = await browser.newContext({
    baseURL,
    storageState: requiredEnv(`STAGING_E2E_${role}_AUTH_STATE`),
    httpCredentials: {
      origin: baseURL,
      username: requiredEnv("STAGING_E2E_BASIC_AUTH_USERNAME"),
      password: requiredEnv("STAGING_E2E_BASIC_AUTH_PASSWORD"),
    },
  });
  const session = await checked(
    await context.request.get("/v1/auth/session"),
    200,
  );
  return { context, csrfToken: requiredString(session.csrfToken) };
}
async function sharedOpenJob(
  customer: Actor,
  provider: Actor,
): Promise<string> {
  const owned = await checked(
    await customer.context.request.get("/v1/me/jobs"),
    200,
  );
  if (!Array.isArray(owned.jobs))
    throw new Error("Synthetic customer Job list unavailable");
  for (const item of owned.jobs as unknown[]) {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !["CONFIRMED", "IN_PROGRESS"].includes(String(item.state))
    )
      continue;
    if (
      (
        await provider.context.request.get(`/v1/me/jobs/${item.id}`)
      ).status() === 200
    )
      return item.id;
  }
  throw new Error("No shared open synthetic Job for Change-order E2E");
}
function terms(title: string, reason: string) {
  return {
    title,
    reason,
    changeDescription:
      "Syntetický test explicitného rozsahu po prijatí ponuky.",
    scopeAdded: ["Montáž doplnkového prvku"],
    scopeRemoved: [],
    scopeChanged: [],
    priceImpact: {
      mode: "FIXED_DELTA",
      amountCents: 12000,
      vatStatus: "VAT_INCLUDED",
    },
    scheduleImpact: { mode: "NONE" },
    materialResponsibility: null,
    warrantyChange: null,
    otherConditionChange: null,
    affectedMilestoneIds: [],
    externalPdfMediaAssetId: null,
  };
}
function agreement(job: Record<string, unknown>) {
  return { acceptedAt: job.acceptedAt, request: job.request, quote: job.quote };
}
function post(actor: Actor, path: string, data: unknown): Promise<APIResponse> {
  return actor.context.request.post(path, {
    data,
    headers: { "x-csrf-token": actor.csrfToken },
  });
}
async function checked(
  response: APIResponse,
  status: number,
): Promise<Record<string, unknown>> {
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as Record<string, unknown>;
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Synthetic response object missing");
  return value;
}
function minimalPdf(): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let pdf = "%PDF-1.7\n% synthetic change-order alpha\n";
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
