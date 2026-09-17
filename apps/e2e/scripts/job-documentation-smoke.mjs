import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, expect } from "@playwright/test";

const root = new URL("../../../", import.meta.url);
const fixture = JSON.parse(
  await readFile(new URL(".alpha/r3-e2e-fixture.json", root), "utf8"),
);
const password = (
  await readFile(new URL(".alpha/secrets/quick_gate_password", root), "utf8")
).trim();
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u.test(fixture.baseURL))
  throw new Error("Unexpected Quick Tunnel origin");

function minimalPdf() {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let pdf = "%PDF-1.7\n% synthetic Job documentation fixture\n";
  const offsets = [];
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

const browser = await chromium.launch({ headless: true });
const contextFor = (id) =>
  browser.newContext({
    baseURL: fixture.baseURL,
    httpCredentials: { origin: fixture.baseURL, username: "alpha", password },
    storageState: fileURLToPath(new URL(`.alpha/r3-e2e-auth-${id}.json`, root)),
  });
async function read(context, path) {
  const response = await context.request.get(path);
  expect(response.status()).toBe(200);
  return response.json();
}
async function token(context) {
  const session = await read(context, "/v1/auth/session");
  expect(typeof session.csrfToken).toBe("string");
  return session.csrfToken;
}

try {
  const customer = await contextFor(104);
  const provider = await contextFor(102);
  const competitor = await contextFor(103);
  try {
    let jobId = process.env.STAGING_E2E_CONFIRMED_JOB_ID;
    if (jobId === undefined) {
      const { jobs } = await read(customer, "/v1/me/jobs");
      const { jobs: providerJobs } = await read(provider, "/v1/me/jobs");
      const providerJobIds = new Set(providerJobs.map((job) => job.id));
      jobId = jobs.find(
        (job) => job.state === "CONFIRMED" && providerJobIds.has(job.id),
      )?.id;
    }
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/iu);
    let conversationId = process.env.STAGING_E2E_WINNING_CONVERSATION_ID;
    if (conversationId === undefined) {
      await expect
        .poll(
          async () =>
            (await provider.request.get(`/v1/me/jobs/${jobId}`)).status(),
          { intervals: [5_000, 10_000, 20_000], timeout: 120_000 },
        )
        .toBe(200);
      const job = await read(provider, `/v1/me/jobs/${jobId}`);
      const conversation = await read(
        provider,
        `/v1/me/invitations/${job.winningInvitationId}/conversation`,
      );
      conversationId = conversation.id;
    }
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/iu);
    const csrfToken = await token(provider);
    const message = await provider.request.post(
      `/v1/me/conversations/${conversationId}/messages`,
      {
        data: {
          body: `Syntetický podklad k zákazke ${randomUUID()
            .replaceAll("-", "")
            .replace(/[0-9a-f]/gu, (digit) =>
              String.fromCharCode(97 + Number.parseInt(digit, 16)),
            )}`,
          commandId: randomUUID(),
        },
        headers: { "x-csrf-token": csrfToken },
      },
    );
    expect(message.status()).toBe(201);
    const messageId = (await message.json()).entry.id;
    const upload = await provider.request.post(
      `/v1/me/conversations/${conversationId}/messages/${messageId}/attachments/documents`,
      {
        data: Buffer.from(minimalPdf()),
        headers: {
          "content-type": "application/pdf",
          "x-csrf-token": csrfToken,
        },
      },
    );
    expect(upload.status()).toBe(202);
    const mediaAssetId = (await upload.json()).assetId;
    expect(mediaAssetId).toMatch(/^[0-9a-f-]{36}$/iu);

    await expect
      .poll(
        async () => {
          const timeline = await read(
            provider,
            `/v1/me/conversations/${conversationId}/timeline?limit=50`,
          );
          for (const entry of timeline.entries ?? []) {
            const attachment = entry.attachments?.find(
              (candidate) => candidate.assetId === mediaAssetId,
            );
            if (attachment) return attachment.status;
          }
          return "MISSING";
        },
        { timeout: 120_000 },
      )
      .toBe("READY");

    const path = `/v1/me/jobs/${jobId}/documentation?category=DOCUMENT&limit=20`;
    const customerDocs = await read(customer, path);
    const providerDocs = await read(provider, path);
    expect(customerDocs).toEqual(providerDocs);
    const document = customerDocs.items.find(
      (item) => item.mediaAssetId === mediaAssetId,
    );
    expect(document).toMatchObject({
      kind: "DOCUMENT",
      source: "WINNING_CONVERSATION",
      sourceMessageId: messageId,
      authorRole: "PRIMARY_PROVIDER",
      downloadPath: `/v1/media/${mediaAssetId}/download`,
    });
    expect((await competitor.request.get(path)).status()).toBe(404);
    expect(
      (
        await customer.request.get(document.downloadPath, { maxRedirects: 0 })
      ).status(),
    ).toBe(303);
    expect(
      (
        await competitor.request.get(document.downloadPath, { maxRedirects: 0 })
      ).status(),
    ).toBe(404);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQYlWNgZGL+TwxmGFXISNfgAQAVt2X1fC3kwgAAAABJRU5ErkJggg==",
      "base64",
    );
    const photoUpload = await provider.request.post(
      `/v1/me/conversations/${conversationId}/messages/${messageId}/attachments/photos`,
      {
        data: png,
        headers: { "content-type": "image/png", "x-csrf-token": csrfToken },
      },
    );
    expect(photoUpload.status()).toBe(202);
    const photoId = (await photoUpload.json()).assetId;
    expect(photoId).toMatch(/^[0-9a-f-]{36}$/iu);
    await expect
      .poll(
        async () => {
          const timeline = await read(
            provider,
            `/v1/me/conversations/${conversationId}/timeline?limit=50`,
          );
          for (const entry of timeline.entries ?? []) {
            const attachment = entry.attachments?.find(
              (candidate) => candidate.assetId === photoId,
            );
            if (attachment) return attachment.status;
          }
          return "MISSING";
        },
        { timeout: 120_000 },
      )
      .toBe("READY");
    const photos = await read(
      customer,
      `/v1/me/jobs/${jobId}/documentation?category=PHOTO&limit=20`,
    );
    const photo = photos.items.find((item) => item.mediaAssetId === photoId);
    expect(photo).toMatchObject({
      kind: "PHOTO",
      source: "WINNING_CONVERSATION",
      sourceMessageId: messageId,
      authorRole: "PRIMARY_PROVIDER",
      capturedAt: null,
      downloadPath: `/v1/media/${photoId}/download`,
    });
    expect(photo.chronologicalAt).toBe(photo.uploadedAt);
    expect(
      (
        await competitor.request.get(photo.downloadPath, { maxRedirects: 0 })
      ).status(),
    ).toBe(404);

    const progressBody = `Syntetický priebeh prác ${randomUUID().slice(0, 8)}.`;
    const progressCommand = {
      commandId: randomUUID(),
      body: progressBody,
      mediaAssetIds: [photoId],
    };
    const progressPath = `/v1/me/jobs/${jobId}/progress`;
    const progressPost = await provider.request.post(progressPath, {
      data: progressCommand,
      headers: { "x-csrf-token": csrfToken },
    });
    expect(progressPost.status(), await progressPost.text()).toBe(201);
    const progressId = (await progressPost.json()).id;
    expect(progressId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(
      (
        await provider.request.post(progressPath, {
          data: progressCommand,
          headers: { "x-csrf-token": csrfToken },
        })
      ).status(),
    ).toBe(200);
    const customerProgress = await read(customer, `${progressPath}?limit=20`);
    expect(
      customerProgress.items.find((item) => item.id === progressId),
    ).toMatchObject({
      body: progressBody,
      media: [
        { mediaAssetId: photoId, sourceMessageId: messageId, kind: "PHOTO" },
      ],
    });
    expect(
      (await competitor.request.get(`${progressPath}/${progressId}`)).status(),
    ).toBe(404);
    const customerCsrf = await token(customer);
    const acknowledge = await customer.request.post(
      `${progressPath}/${progressId}/acknowledge`,
      {
        data: { commandId: randomUUID() },
        headers: { "x-csrf-token": customerCsrf },
      },
    );
    expect(acknowledge.status()).toBe(200);

    const issueBody = `Syntetické zdržanie dodávky ${randomUUID().slice(0, 8)}.`;
    const issuePath = `/v1/me/jobs/${jobId}/issues`;
    const issuePost = await customer.request.post(issuePath, {
      data: {
        commandId: randomUUID(),
        kind: "DELAY",
        body: issueBody,
        mediaAssetIds: [mediaAssetId],
      },
      headers: { "x-csrf-token": customerCsrf },
    });
    expect(issuePost.status(), await issuePost.text()).toBe(201);
    const issueId = (await issuePost.json()).id;
    expect(issueId).toMatch(/^[0-9a-f-]{36}$/iu);
    const providerIssues = await read(provider, `${issuePath}?limit=20`);
    expect(
      providerIssues.items.find((item) => item.id === issueId),
    ).toMatchObject({
      body: issueBody,
      media: [{ mediaAssetId, sourceMessageId: messageId, kind: "DOCUMENT" }],
    });
    expect(
      (await competitor.request.get(`${issuePath}/${issueId}`)).status(),
    ).toBe(404);
    const comment = await provider.request.post(
      `${issuePath}/${issueId}/comments`,
      {
        data: {
          commandId: randomUUID(),
          body: "Dodávku preverujeme so skladom.",
        },
        headers: { "x-csrf-token": csrfToken },
      },
    );
    expect(comment.status()).toBe(201);
    expect(
      (await read(customer, `${issuePath}/${issueId}/comments?limit=20`)).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: "Dodávku preverujeme so skladom." }),
      ]),
    );

    // Repeated synthetic runs can exhaust the private Job-detail rate limit.
    for (const context of [customer, provider]) {
      await expect
        .poll(
          async () =>
            (await context.request.get(`/v1/me/jobs/${jobId}`)).status(),
          { intervals: [5_000, 10_000, 20_000], timeout: 120_000 },
        )
        .toBe(200);
    }

    const progressPage = await customer.newPage();
    expect(
      (
        await progressPage.goto(`/zakazky/${jobId}/priebeh/${progressId}`)
      )?.status(),
    ).toBe(200);
    await expect(progressPage.getByText(progressBody)).toBeVisible();
    await progressPage.close();
    const issuePage = await provider.newPage();
    expect(
      (await issuePage.goto(`/zakazky/${jobId}/problemy/${issueId}`))?.status(),
    ).toBe(200);
    await expect(issuePage.getByText(issueBody)).toBeVisible();
    await issuePage.close();

    const page = await customer.newPage();
    await page.goto(`/zakazky/${jobId}`);
    await expect(
      page.getByRole("heading", { name: "Fotografie a dokumenty" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Dokumenty" }).click();
    await expect(
      page.locator(`a[href="/v1/media/${mediaAssetId}/download"]`).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Fotografie" }).click();
    await expect(
      page.locator(
        `.job-documentation-list img[src="/v1/media/${photoId}/download"]`,
      ),
    ).toBeVisible();
    process.stdout.write(
      "Synthetic R4 Job documentation browser smoke passed.\n",
    );
  } finally {
    await Promise.all([customer.close(), provider.close(), competitor.close()]);
  }
} finally {
  await browser.close();
}
