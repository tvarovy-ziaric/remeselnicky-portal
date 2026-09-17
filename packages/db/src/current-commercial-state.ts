import type {
  ChangeOrderState,
  ChangeOrderTerms,
} from "./change-order-repository.js";

export interface CommercialBaseQuote {
  readonly quoteId: string;
  readonly revision: number;
  readonly authoringMode: "PLATFORM_STRUCTURED" | "EXTERNAL_PDF";
  readonly commercialContent: Readonly<Record<string, unknown>>;
}

export interface CommercialChangeRevision {
  readonly changeOrderId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly state: ChangeOrderState;
  readonly approvedAt: Date;
  readonly terms: ChangeOrderTerms;
}

export type ExactTotalUnavailableReason =
  | "BASE_NOT_FIXED"
  | "BASE_AMOUNT_INVALID"
  | "BASE_CURRENCY_UNSUPPORTED"
  | "BASE_VAT_INVALID"
  | "NON_FIXED_DELTA"
  | "VAT_MISMATCH"
  | "UNSAFE_AMOUNT"
  | "INVALID_APPROVAL_PROVENANCE"
  | "CONFLICTING_APPROVALS";

export interface CurrentCommercialState {
  readonly base: Readonly<CommercialBaseQuote & { source: "BASE_QUOTE" }>;
  readonly approvedChanges: readonly Readonly<{
    source: "APPROVED_CHANGE_ORDER";
    changeOrderId: string;
    revisionId: string;
    revisionNumber: number;
    approvedAt: string;
    terms: Omit<ChangeOrderTerms, "externalPdfMediaAssetId">;
  }>[];
  readonly originalTotalCents: number | null;
  readonly fixedDeltaCents: number | null;
  readonly exactTotalCents: number | null;
  readonly exactTotalUnavailableReason: ExactTotalUnavailableReason | null;
}

const vatStatuses = new Set([
  "VAT_INCLUDED",
  "VAT_EXCLUDED",
  "NOT_VAT_REGISTERED",
]);

/** A read projection: neither unapproved revisions nor uncertain prices alter the agreement. */
export function deriveCurrentCommercialState(
  baseQuote: CommercialBaseQuote,
  revisions: readonly CommercialChangeRevision[],
): CurrentCommercialState {
  const approved = revisions.filter(
    (revision) => revision.state === "APPROVED",
  );
  const invalidProvenance = approved.some(
    (revision) =>
      !(revision.approvedAt instanceof Date) ||
      !Number.isFinite(revision.approvedAt.getTime()),
  );
  const chronological = approved
    .filter(
      (revision) =>
        revision.approvedAt instanceof Date &&
        Number.isFinite(revision.approvedAt.getTime()),
    )
    .sort(
      (left, right) =>
        left.approvedAt.getTime() - right.approvedAt.getTime() ||
        left.changeOrderId.localeCompare(right.changeOrderId) ||
        left.revisionNumber - right.revisionNumber ||
        left.revisionId.localeCompare(right.revisionId),
    );
  const seenRevisions = new Set<string>();
  const changes = chronological
    .filter((revision) => {
      if (seenRevisions.has(revision.revisionId)) return false;
      seenRevisions.add(revision.revisionId);
      return true;
    })
    .map((revision) => {
      const terms: Omit<ChangeOrderTerms, "externalPdfMediaAssetId"> = {
        title: revision.terms.title,
        reason: revision.terms.reason,
        changeDescription: revision.terms.changeDescription,
        scopeAdded: revision.terms.scopeAdded,
        scopeRemoved: revision.terms.scopeRemoved,
        scopeChanged: revision.terms.scopeChanged,
        priceImpact: revision.terms.priceImpact,
        scheduleImpact: revision.terms.scheduleImpact,
        ...(revision.terms.materialResponsibility !== undefined
          ? { materialResponsibility: revision.terms.materialResponsibility }
          : {}),
        ...(revision.terms.warrantyChange !== undefined
          ? { warrantyChange: revision.terms.warrantyChange }
          : {}),
        ...(revision.terms.otherConditionChange !== undefined
          ? { otherConditionChange: revision.terms.otherConditionChange }
          : {}),
        ...(revision.terms.affectedMilestoneIds !== undefined
          ? { affectedMilestoneIds: revision.terms.affectedMilestoneIds }
          : {}),
      };
      return Object.freeze({
        source: "APPROVED_CHANGE_ORDER" as const,
        changeOrderId: revision.changeOrderId,
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        approvedAt: revision.approvedAt.toISOString(),
        terms: Object.freeze(terms),
      });
    });
  const base = Object.freeze({
    source: "BASE_QUOTE" as const,
    quoteId: baseQuote.quoteId,
    revision: baseQuote.revision,
    authoringMode: baseQuote.authoringMode,
    commercialContent: baseQuote.commercialContent,
  });
  const content = baseQuote.commercialContent;
  const baseAmount = content["totalAmountCents"];
  const originalTotalCents =
    content["priceMode"] === "FIXED" &&
    typeof baseAmount === "number" &&
    Number.isSafeInteger(baseAmount) &&
    baseAmount >= 0
      ? baseAmount
      : null;
  let reason: ExactTotalUnavailableReason | null = null;
  if (invalidProvenance) reason = "INVALID_APPROVAL_PROVENANCE";
  else if (content["priceMode"] !== "FIXED") reason = "BASE_NOT_FIXED";
  else if (originalTotalCents === null) reason = "BASE_AMOUNT_INVALID";
  else if (content["currency"] !== "EUR") reason = "BASE_CURRENCY_UNSUPPORTED";
  else if (!vatStatuses.has(content["vatStatus"] as string))
    reason = "BASE_VAT_INVALID";

  const changeOrderIds = new Map<string, string>();
  let fixedDeltaCents = 0;
  for (const change of changes) {
    const priorRevision = changeOrderIds.get(change.changeOrderId);
    if (priorRevision !== undefined && priorRevision !== change.revisionId) {
      reason ??= "CONFLICTING_APPROVALS";
    }
    changeOrderIds.set(change.changeOrderId, change.revisionId);
    const impact = change.terms.priceImpact;
    if (impact.mode === "NONE") continue;
    if (impact.mode !== "FIXED_DELTA") {
      reason ??= "NON_FIXED_DELTA";
      continue;
    }
    if (impact.vatStatus !== content["vatStatus"]) {
      reason ??= "VAT_MISMATCH";
      continue;
    }
    if (
      !Number.isSafeInteger(impact.amountCents) ||
      Math.abs(impact.amountCents) > 1_000_000_000_000 ||
      !Number.isSafeInteger(fixedDeltaCents + impact.amountCents)
    ) {
      reason ??= "UNSAFE_AMOUNT";
      continue;
    }
    fixedDeltaCents += impact.amountCents;
  }
  const total =
    originalTotalCents === null ? null : originalTotalCents + fixedDeltaCents;
  if (
    reason === null &&
    (total === null || !Number.isSafeInteger(total) || total < 0)
  )
    reason = "UNSAFE_AMOUNT";

  return Object.freeze({
    base,
    approvedChanges: Object.freeze(changes),
    originalTotalCents,
    fixedDeltaCents: reason === null ? fixedDeltaCents : null,
    exactTotalCents: reason === null ? total : null,
    exactTotalUnavailableReason: reason,
  });
}
