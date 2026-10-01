import type { PersistedDomainEvent } from "@portal/outbox";

import type { NotificationDraft } from "./model.js";

export const TAXONOMY_SUGGESTION_NOTIFICATION_EVENT_NAMES = Object.freeze({
  submitted: "taxonomy.suggestion.submitted",
  approved: "taxonomy.suggestion.approved",
  mapped: "taxonomy.suggestion.mapped",
  rejected: "taxonomy.suggestion.rejected",
} as const);

/**
 * Maps only routing identifiers and the bounded outcome. Proposal text and the
 * administrator's private/user-facing note stay in the authorized detail.
 */
export function mapTaxonomySuggestionNotificationEvent(
  event: PersistedDomainEvent,
): readonly NotificationDraft[] | undefined {
  if (!isKnownEvent(event.name)) return undefined;
  if (
    event.schemaVersion !== 1 ||
    event.entity?.type !== "TAXONOMY_SUGGESTION" ||
    !isUuid(event.entity.id)
  ) {
    throw new TypeError("Invalid taxonomy suggestion notification envelope.");
  }

  const submitted =
    event.name === TAXONOMY_SUGGESTION_NOTIFICATION_EVENT_NAMES.submitted;
  assertExactKeys(
    event.payload,
    submitted
      ? ["recipient_user_id", "suggestion_id"]
      : [
          "outcome",
          "recipient_user_id",
          "resolved_taxonomy_code",
          "suggestion_id",
        ],
  );
  const suggestionId = requiredUuid(
    event.payload["suggestion_id"],
    "suggestion",
  );
  if (suggestionId !== event.entity.id) {
    throw new TypeError("Taxonomy suggestion identity is incoherent.");
  }
  const recipientUserId = requiredUuid(
    event.payload["recipient_user_id"],
    "recipient",
  );

  if (submitted) {
    return one({
      channels: ["IN_APP"],
      path: `/admin/taxonomy/suggestions/${suggestionId}`,
      action: "REVIEW_TAXONOMY_SUGGESTION",
      priority: "IMPORTANT",
      recipientUserId,
      suggestionId,
      type: event.name,
    });
  }

  const expectedOutcome = outcomeForEvent(event.name);
  if (event.payload["outcome"] !== expectedOutcome) {
    throw new TypeError("Taxonomy suggestion outcome is incoherent.");
  }
  const candidateResolvedTaxonomyCode = event.payload["resolved_taxonomy_code"];
  let resolvedTaxonomyCode: string | null;
  if (expectedOutcome === "REJECTED") {
    if (candidateResolvedTaxonomyCode !== null) {
      throw new TypeError(
        "Rejected taxonomy suggestion cannot resolve an item.",
      );
    }
    resolvedTaxonomyCode = null;
  } else {
    if (!isTaxonomyCode(candidateResolvedTaxonomyCode)) {
      throw new TypeError("Resolved taxonomy code is invalid.");
    }
    resolvedTaxonomyCode = candidateResolvedTaxonomyCode;
  }

  return one({
    channels: ["IN_APP", "EMAIL"],
    path: `/ucet/profil/navrhy/${suggestionId}`,
    action:
      expectedOutcome === "APPROVED_AS_NEW"
        ? "READ_APPROVED_TAXONOMY_SUGGESTION"
        : expectedOutcome === "MAPPED_TO_EXISTING"
          ? "READ_MAPPED_TAXONOMY_SUGGESTION"
          : "READ_REJECTED_TAXONOMY_SUGGESTION",
    outcome: expectedOutcome,
    priority: "IMPORTANT",
    recipientUserId,
    resolvedTaxonomyCode,
    suggestionId,
    type: event.name,
  });
}

function one(input: {
  readonly channels: readonly ("IN_APP" | "EMAIL")[];
  readonly path: string;
  readonly action: string;
  readonly outcome?: "APPROVED_AS_NEW" | "MAPPED_TO_EXISTING" | "REJECTED";
  readonly priority: "IMPORTANT";
  readonly recipientUserId: string;
  readonly resolvedTaxonomyCode?: string | null;
  readonly suggestionId: string;
  readonly type: string;
}): readonly NotificationDraft[] {
  return Object.freeze([
    Object.freeze({
      channels: Object.freeze([...input.channels]),
      context: Object.freeze({
        entityId: input.suggestionId,
        entityType: "TAXONOMY_SUGGESTION",
        path: input.path,
      }),
      payload: Object.freeze({
        action: input.action,
        suggestion_id: input.suggestionId,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.resolvedTaxonomyCode === undefined
          ? {}
          : { resolved_taxonomy_code: input.resolvedTaxonomyCode }),
      }),
      priority: input.priority,
      recipientUserId: input.recipientUserId,
      type: input.type,
    }),
  ]);
}

function outcomeForEvent(
  name: string,
): "APPROVED_AS_NEW" | "MAPPED_TO_EXISTING" | "REJECTED" {
  switch (name) {
    case TAXONOMY_SUGGESTION_NOTIFICATION_EVENT_NAMES.approved:
      return "APPROVED_AS_NEW";
    case TAXONOMY_SUGGESTION_NOTIFICATION_EVENT_NAMES.mapped:
      return "MAPPED_TO_EXISTING";
    case TAXONOMY_SUGGESTION_NOTIFICATION_EVENT_NAMES.rejected:
      return "REJECTED";
    default:
      throw new TypeError("Unsupported taxonomy suggestion outcome event.");
  }
}

function assertExactKeys(
  payload: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(payload).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(
      "Taxonomy suggestion notification payload keys are invalid.",
    );
  }
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value;
}

function isTaxonomyCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:PROF|SERV):[A-Z][A-Z0-9_]{1,62}$/u.test(value)
  );
}

function isKnownEvent(name: string): boolean {
  return Object.values(TAXONOMY_SUGGESTION_NOTIFICATION_EVENT_NAMES).includes(
    name as never,
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
