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
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/u.test(fixture.baseURL)) {
  throw new Error("Unexpected Quick Tunnel origin");
}

const browser = await chromium.launch({ headless: true });
const contextFor = (userId) =>
  browser.newContext({
    baseURL: fixture.baseURL,
    httpCredentials: { origin: fixture.baseURL, username: "alpha", password },
    storageState: fileURLToPath(
      new URL(`.alpha/r3-e2e-auth-${userId}.json`, root),
    ),
  });

try {
  const customer = await contextFor(104);
  const provider = await contextFor(102);
  const competitor = await contextFor(103);
  try {
    const collection = await customer.request.get("/v1/me/jobs");
    expect(collection.status()).toBe(200);
    const { jobs } = await collection.json();
    expect(Array.isArray(jobs)).toBe(true);
    const accepted = jobs.find((job) => job.state === "CONFIRMED");
    expect(accepted?.id).toMatch(/^[0-9a-f-]{36}$/iu);
    const id = accepted.id;

    const customerDetail = await customer.request.get(`/v1/me/jobs/${id}`);
    const providerDetail = await provider.request.get(`/v1/me/jobs/${id}`);
    const competitorDetail = await competitor.request.get(`/v1/me/jobs/${id}`);
    expect(customerDetail.status()).toBe(200);
    expect(providerDetail.status()).toBe(200);
    expect(competitorDetail.status()).toBe(404);
    const customerJob = await customerDetail.json();
    const providerJob = await providerDetail.json();
    expect(customerJob.role).toBe("CUSTOMER");
    expect(providerJob.role).toBe("PRIMARY_PROVIDER");
    expect(customerJob.request.scopeDetails).toBeDefined();
    expect(customerJob.request).toEqual(providerJob.request);
    expect(customerJob.quote).toEqual(providerJob.quote);
    const documentationPath = `/v1/me/jobs/${id}/documentation?category=ALL&limit=20`;
    const customerDocumentation = await customer.request.get(documentationPath);
    const providerDocumentation = await provider.request.get(documentationPath);
    const competitorDocumentation =
      await competitor.request.get(documentationPath);
    expect(customerDocumentation.status()).toBe(200);
    expect(providerDocumentation.status()).toBe(200);
    expect(competitorDocumentation.status()).toBe(404);
    const customerItems = await customerDocumentation.json();
    const providerItems = await providerDocumentation.json();
    expect(customerItems).toEqual(providerItems);
    expect(Array.isArray(customerItems.items)).toBe(true);

    for (const context of [customer, provider]) {
      const page = await context.newPage();
      const response = await page.goto(`/zakazky/${id}`);
      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole("heading", {
          name: "Dohodnutý rozsah · iba na čítanie",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Podrobnosti prijatého zadania" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: /Prijatá ponuka · revízia/u }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Otvoriť pokračujúcu konverzáciu" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Fotografie a dokumenty" }),
      ).toBeVisible();
      await page.close();
    }

    const deniedPage = await competitor.newPage();
    await deniedPage.goto(`/zakazky/${id}`);
    await expect(
      deniedPage.getByRole("alert").getByText("Zákazka nie je dostupná."),
    ).toBeVisible();
    process.stdout.write("Synthetic R4 Job dashboard browser smoke passed.\n");
  } finally {
    await Promise.all([customer.close(), provider.close(), competitor.close()]);
  }
} finally {
  await browser.close();
}
