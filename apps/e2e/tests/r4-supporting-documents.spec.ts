import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from "@playwright/test";

const enabled = process.env.STAGING_E2E_ENABLED === "true";
const quoteId = process.env.STAGING_E2E_QUOTE_A_ID;
const requestId = process.env.STAGING_E2E_REQUEST_A_ID;

test.skip(!enabled, "Synthetic public alpha fixture is not provisioned");

test("explicit supporting PDF stays private and appears in the submitted recap", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(180_000);
  test.skip(browserName !== "chromium", "One media pipeline run is sufficient");
  if (quoteId === undefined || requestId === undefined) {
    throw new Error("Synthetic Quote fixture is unavailable");
  }
  const provider = await authenticated(browser, "PROVIDER_A");
  const competitor = await authenticated(browser, "PROVIDER_B");
  const customer = await authenticated(browser, "CUSTOMER");
  const otherCustomer = await authenticated(browser, "CUSTOMER_B");
  try {
    const quotePath = `/v1/me/quotes/${quoteId}`;
    let quote = await readQuote(provider.context, quotePath);
    const submitted = quote.currentSubmitted;
    if (submitted === null) throw new Error("Synthetic Quote is not submitted");
    let revision = submitted.revision;
    let documentsPath = `${quotePath}/revisions/${revision}/supporting-documents`;
    let documents = await readDocuments(provider.context, documentsPath);

    if (documents.length === 0) {
      if (quote.currentDraft === null) {
        const created = await provider.context.request.post(
          `${quotePath}/revisions`,
          {
            data: {
              authoringMode: "PLATFORM_STRUCTURED",
              commandId: randomUUID(),
              expectedSubmittedStateRevision: submitted.stateRevision,
              requestContentRevision: submitted.requestContentRevision,
              requestVisibleVersion: submitted.requestVisibleVersion,
            },
            headers: { "x-csrf-token": provider.csrfToken },
          },
        );
        expect(created.status()).toBe(201);
        quote = await readQuote(provider.context, quotePath);
      }
      const draft = quote.currentDraft;
      if (draft === null || draft.authoringMode !== "PLATFORM_STRUCTURED") {
        throw new Error("Synthetic structured Quote draft is unavailable");
      }
      revision = draft.revision;
      documentsPath = `${quotePath}/revisions/${revision}/supporting-documents`;
      documents = await readDocuments(provider.context, documentsPath);

      if (documents.length === 0) {
        const upload = await provider.context.request.post(
          `${documentsPath}/upload`,
          {
            data: Buffer.from(minimalPdf()),
            headers: {
              "content-type": "application/pdf",
              "x-csrf-token": provider.csrfToken,
            },
          },
        );
        expect(upload.status()).toBe(202);
        const uploaded = (await upload.json()) as {
          assetId?: unknown;
          status?: unknown;
        };
        expect(uploaded.status).toBe("PROCESSING");
        if (typeof uploaded.assetId !== "string") {
          throw new Error("Supporting PDF upload did not return an asset ID");
        }

        expectNotFound(await customer.context.request.get(documentsPath));
        expectNotFound(await competitor.context.request.get(documentsPath));
        const competitorBind = await competitor.context.request.post(
          documentsPath,
          {
            data: { commandId: randomUUID(), mediaAssetId: uploaded.assetId },
            headers: { "x-csrf-token": competitor.csrfToken },
          },
        );
        expectNotFound(competitorBind);

        const bindCommandId = randomUUID();
        let attached = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          const bind = await provider.context.request.post(documentsPath, {
            data: { commandId: bindCommandId, mediaAssetId: uploaded.assetId },
            headers: { "x-csrf-token": provider.csrfToken },
          });
          if (bind.status() === 201 || bind.status() === 200) {
            const result = (await bind.json()) as { status?: unknown };
            expect(["ATTACHED", "DEDUPLICATED"]).toContain(result.status);
            attached = true;
            break;
          }
          expect(bind.status()).toBe(409);
          const failure = (await bind.json()) as { code?: unknown };
          expect(failure.code).toBe("DOCUMENT_NOT_READY");
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        expect(attached).toBe(true);
        documents = await readDocuments(provider.context, documentsPath);
      }

      expect(documents).toHaveLength(1);
      const document = documents[0];
      if (document === undefined) throw new Error("Supporting PDF is missing");
      expect(document.downloadPath).toBe(
        `/v1/media/${document.mediaAssetId}/download`,
      );
      expectNotFound(
        await customer.context.request.get(document.downloadPath, {
          maxRedirects: 0,
        }),
      );

      const contentPath = `${quotePath}/revisions/${revision}/structured`;
      const existingContent = await provider.context.request.get(contentPath);
      if (existingContent.status() === 404) {
        const saved = await provider.context.request.post(contentPath, {
          data: {
            commandId: randomUUID(),
            expectedContentRevision: 0,
            content: {
              components: {},
              conditionalOnInspection: false,
              currency: "EUR",
              materialResponsibility: "PROVIDER",
              priceBasis: "Cena za syntetické práce.",
              priceMode: "FIXED",
              summary: required("STAGING_E2E_PROVIDER_A_CANARY"),
              title: "Syntetická ponuka A",
              totalAmountCents: 125000,
              vatStatus: "VAT_INCLUDED",
            },
          },
          headers: { "x-csrf-token": provider.csrfToken },
        });
        expect(saved.status()).toBe(200);
      } else {
        expect(existingContent.status()).toBe(200);
      }

      quote = await readQuote(provider.context, quotePath);
      const currentDraft = quote.currentDraft;
      const currentSubmitted = quote.currentSubmitted;
      if (currentDraft === null || currentSubmitted === null) {
        throw new Error("Synthetic Quote revisions changed unexpectedly");
      }
      const submit = await provider.context.request.post(
        `${quotePath}/revisions/${revision}/submit`,
        {
          data: {
            commandId: randomUUID(),
            expectedDraftStateRevision: currentDraft.stateRevision,
            expectedSubmittedStateRevision: currentSubmitted.stateRevision,
          },
          headers: { "x-csrf-token": provider.csrfToken },
        },
      );
      expect(submit.status()).toBe(200);
    }

    const submittedDocuments = await readDocuments(
      customer.context,
      documentsPath,
    );
    expect(submittedDocuments).toHaveLength(1);
    const document = submittedDocuments[0];
    if (document === undefined) throw new Error("Submitted PDF is missing");
    expectNotFound(await competitor.context.request.get(documentsPath));
    expectNotFound(await otherCustomer.context.request.get(documentsPath));
    expectNotFound(
      await competitor.context.request.get(document.downloadPath, {
        maxRedirects: 0,
      }),
    );
    const authorized = await customer.context.request.get(
      document.downloadPath,
      { maxRedirects: 0 },
    );
    expect(authorized.status()).toBe(303);
    const location = authorized.headers()["location"];
    if (location === undefined) throw new Error("Signed PDF path is missing");
    const downloaded = await customer.context.request.get(location);
    expect(downloaded.status()).toBe(200);
    expect((await downloaded.body()).subarray(0, 5).toString("latin1")).toBe(
      "%PDF-",
    );

    const page = await customer.context.newPage();
    const recap = await page.goto(
      `/ziadosti/${requestId}/ponuky/${quoteId}/potvrdenie`,
    );
    expect(recap?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Rekapitulácia vybranej ponuky" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Podporný dokument 1 (PDF)" }),
    ).toHaveAttribute("href", document.downloadPath);
    await expect(
      page.getByRole("button", {
        name: "Potvrdiť ponuku a vytvoriť zákazku",
      }),
    ).toBeEnabled();
  } finally {
    await Promise.all([
      provider.context.close(),
      competitor.context.close(),
      customer.context.close(),
      otherCustomer.context.close(),
    ]);
  }
});

interface QuoteRevision {
  readonly authoringMode: string;
  readonly requestContentRevision: number;
  readonly requestVisibleVersion: number;
  readonly revision: number;
  readonly stateRevision: number;
}

async function readQuote(
  context: BrowserContext,
  path: string,
): Promise<{
  readonly currentDraft: QuoteRevision | null;
  readonly currentSubmitted: QuoteRevision | null;
}> {
  const response = await context.request.get(path);
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    currentDraft: QuoteRevision | null;
    currentSubmitted: QuoteRevision | null;
  };
}

async function readDocuments(
  context: BrowserContext,
  path: string,
): Promise<readonly { mediaAssetId: string; downloadPath: string }[]> {
  const response = await context.request.get(path);
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as unknown;
  const candidates =
    typeof payload === "object" && payload !== null && "documents" in payload
      ? payload.documents
      : null;
  if (!Array.isArray(candidates)) {
    throw new Error("Supporting-document response is malformed");
  }
  const entries: readonly unknown[] = candidates;
  return entries.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("mediaAssetId" in entry) ||
      !("downloadPath" in entry) ||
      typeof entry.mediaAssetId !== "string" ||
      typeof entry.downloadPath !== "string"
    ) {
      throw new Error("Supporting-document entry is malformed");
    }
    return {
      downloadPath: entry.downloadPath,
      mediaAssetId: entry.mediaAssetId,
    };
  });
}

function expectNotFound(response: APIResponse): void {
  expect(response.status()).toBe(404);
  expect(response.headers()).not.toHaveProperty("location");
  expect(response.headers()["cache-control"]).toContain("no-store");
}

async function authenticated(
  browser: Browser,
  actor: "CUSTOMER" | "CUSTOMER_B" | "PROVIDER_A" | "PROVIDER_B",
): Promise<Readonly<{ context: BrowserContext; csrfToken: string }>> {
  const context = await browser.newContext({
    baseURL: required("STAGING_E2E_BASE_URL"),
    ...accessHeaders(),
    ...(process.env[`STAGING_E2E_${actor}_AUTH_STATE`] === undefined
      ? {}
      : { storageState: required(`STAGING_E2E_${actor}_AUTH_STATE`) }),
  });
  const session = await context.request.get("/v1/auth/session");
  expect(session.status()).toBe(200);
  const payload = (await session.json()) as { csrfToken?: unknown };
  if (typeof payload.csrfToken !== "string") {
    throw new Error("Authenticated session CSRF token is missing");
  }
  return { context, csrfToken: payload.csrfToken };
}

function accessHeaders(): Readonly<{
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string; origin: string };
}> {
  const clientId = process.env.STAGING_E2E_CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.STAGING_E2E_CF_ACCESS_CLIENT_SECRET;
  if (clientId !== undefined && clientSecret !== undefined) {
    return {
      extraHTTPHeaders: {
        "CF-Access-Client-Id": clientId,
        "CF-Access-Client-Secret": clientSecret,
      },
    };
  }
  const username = process.env.STAGING_E2E_BASIC_AUTH_USERNAME;
  const password = process.env.STAGING_E2E_BASIC_AUTH_PASSWORD;
  if (username !== undefined && password !== undefined) {
    return {
      httpCredentials: {
        origin: required("STAGING_E2E_BASE_URL"),
        password,
        username,
      },
    };
  }
  return {};
}

function minimalPdf(): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let pdf = "%PDF-1.7\n% synthetic supporting-document alpha\n";
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

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing staging E2E input ${name}`);
  }
  return value;
}
