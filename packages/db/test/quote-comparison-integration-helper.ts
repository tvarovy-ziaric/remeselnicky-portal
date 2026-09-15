import type { QuoteAuthoringMode, UserId } from "@portal/domain";
import type { Sql } from "postgres";
import { expect } from "vitest";

import { createQuoteComparisonRepository } from "../src/quote-comparison-repository.js";

interface Fixture {
  readonly customerOwnerId: UserId;
  readonly jobRequestId: string;
  readonly providerOwnerId: UserId;
}

/** Standalone R3-018 live assertions; the single migration runner owns wiring. */
export async function runQuoteComparisonIntegrationAssertions(
  sql: Sql,
  expectedMode: QuoteAuthoringMode,
): Promise<void> {
  const [fixture] = await sql<Fixture[]>`
    SELECT customer.owner_user_id AS "customerOwnerId",
      invitation.job_request_id AS "jobRequestId",
      craftsman.owner_user_id AS "providerOwnerId"
    FROM current_submitted_quotes submitted
    JOIN quotes quote ON quote.id = submitted.quote_id
    JOIN job_invitations invitation ON invitation.id = quote.invitation_id
    JOIN customer_profiles customer ON customer.id = invitation.customer_profile_id
    JOIN craftsman_profiles craftsman ON craftsman.id = invitation.craftsman_profile_id
    JOIN users customer_owner ON customer_owner.id = customer.owner_user_id
      AND customer_owner.account_state = 'ACTIVE'
    WHERE submitted.authoring_mode = ${expectedMode}
      AND (${expectedMode} <> 'PLATFORM_STRUCTURED' OR EXISTS (
        SELECT 1 FROM current_quote_structured_content content
        WHERE content.quote_id = submitted.quote_id
          AND content.quote_revision = submitted.revision
      ))
      AND (${expectedMode} <> 'EXTERNAL_PDF' OR EXISTS (
        SELECT 1 FROM current_quote_external_pdf_content content
        JOIN quote_external_pdf_documents document
          ON document.quote_id = content.quote_id
          AND document.quote_revision = content.quote_revision
          AND document.pdf_media_asset_id = content.pdf_media_asset_id
        JOIN media_assets asset ON asset.id = content.pdf_media_asset_id
          AND asset.status = 'READY'
        JOIN media_asset_storage_objects object
          ON object.media_asset_id = asset.id AND object.role = 'CANONICAL'
          AND object.storage_area = 'private' AND object.revoked_at IS NULL
        WHERE content.quote_id = submitted.quote_id
          AND content.quote_revision = submitted.revision
          AND content.provider_confirmed_summary_matches_pdf
      ))
    ORDER BY submitted.submitted_at DESC, quote.id DESC
    LIMIT 1
  `;
  if (fixture === undefined) {
    throw new Error(
      `R3-018 requires an accessible ${expectedMode} submitted Quote fixture.`,
    );
  }
  const repository = createQuoteComparisonRepository(sql);
  const comparison = await repository.readCurrent({
    actorUserId: fixture.customerOwnerId,
    jobRequestId: fixture.jobRequestId as never,
  });
  expect(comparison).not.toBeNull();
  expect(
    comparison?.items.some((item) => item.authoringMode === expectedMode),
  ).toBe(true);
  const payload = JSON.stringify(comparison);
  expect(payload).not.toMatch(
    /ownerUserId|customerProfileId|craftsmanProfileId|storage|sha256|evidenceId/iu,
  );
  await expect(
    repository.readCurrent({
      actorUserId: fixture.providerOwnerId,
      jobRequestId: fixture.jobRequestId as never,
    }),
  ).resolves.toBeNull();
}
