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

test("milestone planning, customer proposal and discussion stay within one synthetic Job", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  test.skip(
    browserName !== "chromium",
    "One synthetic mutation run is sufficient",
  );
  const customer = await authenticated(browser, "CUSTOMER_B");
  const provider = await authenticated(browser, "PROVIDER_B");
  const outsider = await authenticated(browser, "CUSTOMER_A");
  try {
    const owned = await checked(
      await customer.context.request.get("/v1/me/jobs"),
      200,
    );
    if (!Array.isArray(owned.jobs))
      throw new Error("Synthetic customer Job list is unavailable");
    const jobs: unknown[] = owned.jobs;
    let jobId: string | null = null;
    for (const job of jobs) {
      if (
        !isRecord(job) ||
        typeof job.id !== "string" ||
        !["CONFIRMED", "IN_PROGRESS"].includes(String(job.state))
      )
        continue;
      if (
        (
          await provider.context.request.get(`/v1/me/jobs/${job.id}`)
        ).status() === 200
      ) {
        jobId = job.id;
        break;
      }
    }
    if (jobId === null)
      throw new Error(
        "No shared open synthetic Job exists for milestone smoke",
      );
    const collection = `/v1/me/jobs/${jobId}/milestones`;
    const proposals = `/v1/me/jobs/${jobId}/milestone-proposals`;
    const title = `Syntetický míľnik ${randomUUID().slice(0, 8)}`;
    expect((await outsider.context.request.get(collection)).status()).toBe(404);
    expect(
      (
        await post(customer, collection, { commandId: randomUUID(), title })
      ).status(),
    ).toBe(404);
    const created = await checked(
      await post(provider, collection, { commandId: randomUUID(), title }),
      201,
    );
    const milestoneId = requiredString(created.milestoneId);
    const detail = `${collection}/${milestoneId}`;
    expect(
      (await checked(await customer.context.request.get(detail), 200)).title,
    ).toBe(title);
    const proposalTitle = `${title} – upravený plán`;
    const proposed = await checked(
      await post(customer, proposals, {
        commandId: randomUUID(),
        targetMilestoneId: milestoneId,
        title: proposalTitle,
        description: "Syntetický návrh bez zmeny obchodnej dohody.",
      }),
      201,
    );
    const proposalId = requiredString(proposed.id);
    const providerProposal = await checked(
      await provider.context.request.get(`${proposals}/${proposalId}`),
      200,
    );
    expect(providerProposal).toMatchObject({
      title: proposalTitle,
      canDecide: true,
      decision: null,
    });
    expect(
      (
        await outsider.context.request.get(`${proposals}/${proposalId}`)
      ).status(),
    ).toBe(404);
    const accepted = await checked(
      await post(provider, `${proposals}/${proposalId}/decision`, {
        commandId: randomUUID(),
        decision: "ACCEPT",
      }),
      201,
    );
    expect(accepted.appliedMilestoneId).toBe(milestoneId);
    expect(
      (await checked(await customer.context.request.get(detail), 200)).title,
    ).toBe(proposalTitle);
    const commentPath = `${detail}/comments`;
    await checked(
      await post(customer, commentPath, {
        commandId: randomUUID(),
        body: "Syntetická otázka k priebehu.",
      }),
      201,
    );
    const comments = await checked(
      await provider.context.request.get(commentPath),
      200,
    );
    expect(JSON.stringify(comments.items)).toContain(
      "Syntetická otázka k priebehu.",
    );
    const history = await checked(
      await provider.context.request.get(`${detail}/history?limit=20`),
      200,
    );
    expect(JSON.stringify(history.items)).toContain(proposalTitle);
    const page = await provider.context.newPage();
    const response = await page.goto(
      `/zakazky/${jobId}/milniky/${milestoneId}`,
    );
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: proposalTitle }),
    ).toBeVisible();
  } finally {
    await customer.context.close();
    await provider.context.close();
    await outsider.context.close();
  }
});

test("milestone media remains a private link to central Job documentation", async ({
  browser,
  browserName,
}) => {
  test.setTimeout(120_000);
  test.skip(
    browserName !== "chromium",
    "One synthetic mutation run is sufficient",
  );
  const customer = await authenticated(browser, "CUSTOMER_B");
  const provider = await authenticated(browser, "PROVIDER_A");
  const outsider = await authenticated(browser, "CUSTOMER_A");
  try {
    const owned = await checked(
      await customer.context.request.get("/v1/me/jobs"),
      200,
    );
    if (!Array.isArray(owned.jobs))
      throw new Error("Synthetic Job list is unavailable");
    let selected: { jobId: string; mediaAssetId: string } | null = null;
    const jobs: unknown[] = owned.jobs;
    for (const job of jobs) {
      if (
        !isRecord(job) ||
        typeof job.id !== "string" ||
        !["CONFIRMED", "IN_PROGRESS"].includes(String(job.state))
      )
        continue;
      if (
        (
          await provider.context.request.get(`/v1/me/jobs/${job.id}`)
        ).status() !== 200
      )
        continue;
      const documents = await checked(
        await customer.context.request.get(
          `/v1/me/jobs/${job.id}/documentation?category=ALL&limit=20`,
        ),
        200,
      );
      if (!Array.isArray(documents.items)) continue;
      const items: unknown[] = documents.items;
      const first = items.find(
        (item) => isRecord(item) && typeof item.mediaAssetId === "string",
      );
      if (isRecord(first) && typeof first.mediaAssetId === "string") {
        selected = { jobId: job.id, mediaAssetId: first.mediaAssetId };
        break;
      }
    }
    if (selected === null)
      throw new Error(
        "No synthetic open Job with central documentation exists",
      );
    const collection = `/v1/me/jobs/${selected.jobId}/milestones`;
    const created = await checked(
      await post(provider, collection, {
        commandId: randomUUID(),
        title: `Syntetická príloha ${randomUUID().slice(0, 8)}`,
      }),
      201,
    );
    const milestoneId = requiredString(created.milestoneId);
    const mediaPath = `${collection}/${milestoneId}/media`;
    expect((await outsider.context.request.get(mediaPath)).status()).toBe(404);
    await checked(
      await post(provider, mediaPath, {
        commandId: randomUUID(),
        mediaAssetId: selected.mediaAssetId,
      }),
      201,
    );
    const linked = await checked(
      await customer.context.request.get(mediaPath),
      200,
    );
    expect(JSON.stringify(linked.items)).toContain(selected.mediaAssetId);
    const central = await checked(
      await customer.context.request.get(
        `/v1/me/jobs/${selected.jobId}/documentation?category=ALL&limit=20`,
      ),
      200,
    );
    expect(JSON.stringify(central.items)).toContain(selected.mediaAssetId);
  } finally {
    await customer.context.close();
    await provider.context.close();
    await outsider.context.close();
  }
});

interface Actor {
  readonly context: BrowserContext;
  readonly csrfToken: string;
}
async function authenticated(
  browser: Browser,
  role: "CUSTOMER_A" | "CUSTOMER_B" | "PROVIDER_A" | "PROVIDER_B",
): Promise<Actor> {
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
function post(actor: Actor, path: string, data: unknown): Promise<APIResponse> {
  return actor.context.request.post(path, {
    data,
    headers: { "x-csrf-token": actor.csrfToken },
  });
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
  if (!value) throw new Error(`Missing synthetic E2E input ${name}`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
