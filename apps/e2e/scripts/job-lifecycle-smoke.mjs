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

const browser = await chromium.launch({ headless: true });
const contextFor = (id) =>
  browser.newContext({
    baseURL: fixture.baseURL,
    httpCredentials: { origin: fixture.baseURL, username: "alpha", password },
    storageState: fileURLToPath(new URL(`.alpha/r3-e2e-auth-${id}.json`, root)),
  });

async function token(context) {
  const response = await context.request.get("/v1/auth/session");
  expect(response.status()).toBe(200);
  const session = await response.json();
  expect(typeof session.csrfToken).toBe("string");
  return session.csrfToken;
}

async function command(context, url, csrfToken, body) {
  return context.request.post(url, {
    data: body,
    headers: { "x-csrf-token": csrfToken },
  });
}

try {
  const customer = await contextFor(104);
  const provider = await contextFor(102);
  const competitor = await contextFor(103);
  try {
    const list = await customer.request.get("/v1/me/jobs");
    expect(list.status()).toBe(200);
    const { jobs } = await list.json();
    const confirmed = jobs.find((job) => job.state === "CONFIRMED");
    expect(confirmed?.id).toMatch(/^[0-9a-f-]{36}$/iu);
    const jobId = confirmed.id;
    const startUrl = `/v1/me/jobs/${jobId}/start`;
    const cancelUrl = `/v1/me/jobs/${jobId}/cancel`;
    const customerToken = await token(customer);
    const providerToken = await token(provider);

    const deniedStart = await command(customer, startUrl, customerToken, {
      commandId: randomUUID(),
    });
    expect(deniedStart.status()).toBe(404);
    const deniedCompetitor = await command(
      competitor,
      startUrl,
      await token(competitor),
      { commandId: randomUUID() },
    );
    expect(deniedCompetitor.status()).toBe(404);

    const start = { commandId: randomUUID() };
    expect(
      (await command(provider, startUrl, providerToken, start)).status(),
    ).toBe(201);
    expect(
      (await command(provider, startUrl, providerToken, start)).status(),
    ).toBe(200);
    const started = await customer.request.get(`/v1/me/jobs/${jobId}`);
    expect(started.status()).toBe(200);
    const startedJob = await started.json();
    expect(startedJob.state).toBe("IN_PROGRESS");
    expect(startedJob.timeline.at(-1).eventType).toBe("JOB_STARTED");
    expect(startedJob.timeline.at(-1).actorRole).toBe("PRIMARY_PROVIDER");

    const reason = "Syntetická skúška zrušenia po začatí prác.";
    const cancel = {
      commandId: randomUUID(),
      expectedState: "IN_PROGRESS",
      reason,
    };
    expect(
      (await command(customer, cancelUrl, customerToken, cancel)).status(),
    ).toBe(201);
    expect(
      (await command(customer, cancelUrl, customerToken, cancel)).status(),
    ).toBe(200);
    const cancelled = await provider.request.get(`/v1/me/jobs/${jobId}`);
    expect(cancelled.status()).toBe(200);
    const cancelledJob = await cancelled.json();
    expect(cancelledJob.state).toBe("CANCELLED");
    expect(cancelledJob.timeline.at(-1)).toMatchObject({
      eventType: "JOB_CANCELLED",
      actorRole: "CUSTOMER",
      reason,
    });
    expect(cancelledJob.request).toEqual(startedJob.request);
    expect(cancelledJob.quote).toEqual(startedJob.quote);

    const page = await provider.newPage();
    const pageResponse = await page.goto(`/zakazky/${jobId}`);
    expect(pageResponse?.status()).toBe(200);
    await expect(page.getByText(reason)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Systémová história" }),
    ).toBeVisible();
    expect(
      await page.getByRole("button", { name: "Zrušiť zákazku" }).count(),
    ).toBe(0);
    process.stdout.write("Synthetic R4 Job lifecycle browser smoke passed.\n");
  } finally {
    await Promise.all([customer.close(), provider.close(), competitor.close()]);
  }
} finally {
  await browser.close();
}
