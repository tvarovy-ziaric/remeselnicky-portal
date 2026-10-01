import { randomUUID } from "node:crypto";

import type { PersistedDomainEvent } from "@portal/outbox";
import { describe, expect, it } from "vitest";

import {
  getNotificationPresentation,
  mapDemandSideNotificationEvent,
  mapTaxonomySuggestionNotificationEvent,
  validateNotificationDraft,
} from "../src/index.js";

const suggestionId = randomUUID();
const recipientUserId = randomUUID();

function event(
  name: string,
  payload: Readonly<Record<string, string | null>>,
): PersistedDomainEvent {
  return {
    entity: { id: suggestionId, type: "TAXONOMY_SUGGESTION" },
    eventId: randomUUID(),
    idempotencyKey: `taxonomy-suggestion:${randomUUID()}`,
    name,
    occurredAt: new Date("2026-10-01T10:00:00.000Z"),
    payload,
    schemaVersion: 1,
  };
}

describe("managed taxonomy suggestion notifications", () => {
  it("creates a privacy-minimal actionable admin notice", () => {
    const draft = mapDemandSideNotificationEvent(
      event("taxonomy.suggestion.submitted", {
        recipient_user_id: recipientUserId,
        suggestion_id: suggestionId,
      }),
    )?.[0];
    expect(draft).toMatchObject({
      channels: ["IN_APP"],
      context: {
        entityId: suggestionId,
        entityType: "TAXONOMY_SUGGESTION",
        path: `/admin/taxonomy/suggestions/${suggestionId}`,
      },
      payload: {
        action: "REVIEW_TAXONOMY_SUGGESTION",
        suggestion_id: suggestionId,
      },
      priority: "IMPORTANT",
      recipientUserId,
    });
    expect(() => validateNotificationDraft(draft as never)).not.toThrow();
  });

  it.each([
    ["approved", "APPROVED_AS_NEW", "PROF:ELECTRICIAN"],
    ["mapped", "MAPPED_TO_EXISTING", "SERV:VINYL_FLOOR"],
    ["rejected", "REJECTED", null],
  ] as const)(
    "notifies the requester when a suggestion is %s",
    (suffix, outcome, resolvedTaxonomyCode) => {
      const draft = mapTaxonomySuggestionNotificationEvent(
        event(`taxonomy.suggestion.${suffix}`, {
          outcome,
          recipient_user_id: recipientUserId,
          resolved_taxonomy_code: resolvedTaxonomyCode,
          suggestion_id: suggestionId,
        }),
      )?.[0];
      expect(draft).toMatchObject({
        channels: ["IN_APP", "EMAIL"],
        context: { path: `/ucet/profil/navrhy/${suggestionId}` },
        payload: { outcome, resolved_taxonomy_code: resolvedTaxonomyCode },
        recipientUserId,
      });
      expect(() => validateNotificationDraft(draft as never)).not.toThrow();
      expect(getNotificationPresentation(draft?.type ?? "", {})).toMatchObject({
        category: "MARKETPLACE",
        emailRequired: true,
      });
    },
  );

  it("rejects spoofed outcomes, free text and private decision notes", () => {
    expect(() =>
      mapTaxonomySuggestionNotificationEvent(
        event("taxonomy.suggestion.mapped", {
          outcome: "REJECTED",
          recipient_user_id: recipientUserId,
          resolved_taxonomy_code: null,
          suggestion_id: suggestionId,
        }),
      ),
    ).toThrow("outcome");
    for (const forbidden of ["description", "admin_decision_note"]) {
      expect(() =>
        mapTaxonomySuggestionNotificationEvent({
          ...event("taxonomy.suggestion.submitted", {
            recipient_user_id: recipientUserId,
            suggestion_id: suggestionId,
          }),
          payload: {
            recipient_user_id: recipientUserId,
            suggestion_id: suggestionId,
            [forbidden]: "private text",
          },
        }),
      ).toThrow("payload keys");
    }
  });

  it("requires resolved item codes for approved and mapped outcomes", () => {
    expect(() =>
      mapTaxonomySuggestionNotificationEvent(
        event("taxonomy.suggestion.approved", {
          outcome: "APPROVED_AS_NEW",
          recipient_user_id: recipientUserId,
          resolved_taxonomy_code: null,
          suggestion_id: suggestionId,
        }),
      ),
    ).toThrow("code");
  });
});
