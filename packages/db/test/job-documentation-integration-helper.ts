import type { Sql } from "postgres";
import { expect } from "vitest";

import { createJobDocumentationRepository } from "../src/job-documentation-repository.js";

export async function runJobDocumentationIntegrationAssertions(sql: Sql) {
  const [job] = await sql<
    Array<{ id: string; customerUserId: string; providerUserId: string }>
  >`
    SELECT job.id, customer.owner_user_id AS "customerUserId",
      provider.owner_user_id AS "providerUserId"
    FROM jobs job
    JOIN customer_profiles customer ON customer.id = job.customer_profile_id
    JOIN craftsman_profiles provider
      ON provider.id = job.primary_craftsman_profile_id
    ORDER BY job.accepted_at DESC, job.id DESC LIMIT 1
  `;
  if (!job) throw new Error("Confirmed Job fixture missing.");
  const repository = createJobDocumentationRepository(sql);
  const customer = await repository.listForPrimaryParty({
    actorUserId: job.customerUserId,
    category: "ALL",
    jobId: job.id,
    limit: 20,
  });
  const provider = await repository.listForPrimaryParty({
    actorUserId: job.providerUserId,
    category: "DOCUMENT",
    jobId: job.id,
    limit: 20,
  });
  expect(customer).not.toBeNull();
  expect(provider).not.toBeNull();
  expect(Array.isArray(customer?.items)).toBe(true);
  expect(Array.isArray(provider?.items)).toBe(true);
  expect(
    customer?.items.every((item) => item.downloadPath.startsWith("/v1/media/")),
  ).toBe(true);

  const [unrelated] = await sql<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE id <> ${job.customerUserId} AND id <> ${job.providerUserId}
    ORDER BY id LIMIT 1
  `;
  if (!unrelated) throw new Error("Unrelated User fixture missing.");
  expect(
    await repository.listForPrimaryParty({
      actorUserId: unrelated.id,
      category: "ALL",
      jobId: job.id,
      limit: 20,
    }),
  ).toBeNull();
}
