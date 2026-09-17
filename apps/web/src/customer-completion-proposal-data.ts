const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Dict = Record<string, unknown>;
const record = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Dict, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length >= min &&
  value.length <= max &&
  !/[\p{Cc}]/u.test(value);

export interface CustomerCompletionProposal {
  readonly id: string;
  readonly proposalNumber: number;
  readonly proposedAt: string;
  readonly note: string | null;
  readonly outcome: "PENDING" | "AGREE" | "DISAGREE";
  readonly decidedAt: string | null;
  readonly disagreementReason: string | null;
}
export type ProposalLoad =
  | {
      readonly status: "OK";
      readonly proposals: readonly CustomerCompletionProposal[];
    }
  | { readonly status: "AUTH_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE" };

export function parseCustomerCompletionProposals(
  value: unknown,
): readonly CustomerCompletionProposal[] | null {
  if (
    !record(value) ||
    !exact(value, ["proposals"]) ||
    !Array.isArray(value.proposals) ||
    value.proposals.length > 10_000
  )
    return null;
  const proposals: CustomerCompletionProposal[] = [];
  let pending = 0;
  for (const raw of value.proposals as unknown[]) {
    if (
      !record(raw) ||
      !exact(raw, [
        "id",
        "proposalNumber",
        "proposedAt",
        "note",
        "outcome",
        "decidedAt",
        "disagreementReason",
      ]) ||
      typeof raw.id !== "string" ||
      !uuid.test(raw.id) ||
      typeof raw.proposalNumber !== "number" ||
      !Number.isSafeInteger(raw.proposalNumber) ||
      raw.proposalNumber < 1 ||
      (proposals.length > 0 &&
        raw.proposalNumber !==
          proposals[proposals.length - 1]!.proposalNumber - 1) ||
      !instant(raw.proposedAt) ||
      (raw.note !== null && !text(raw.note, 1, 1000)) ||
      !["PENDING", "AGREE", "DISAGREE"].includes(String(raw.outcome)) ||
      (raw.decidedAt !== null &&
        (!instant(raw.decidedAt) ||
          Date.parse(raw.decidedAt) < Date.parse(raw.proposedAt))) ||
      (raw.disagreementReason !== null &&
        !text(raw.disagreementReason, 8, 1000)) ||
      (raw.outcome === "PENDING" &&
        (raw.decidedAt !== null || raw.disagreementReason !== null)) ||
      (raw.outcome === "AGREE" &&
        (raw.decidedAt === null || raw.disagreementReason !== null)) ||
      (raw.outcome === "DISAGREE" &&
        (raw.decidedAt === null || raw.disagreementReason === null))
    )
      return null;
    if (raw.outcome === "PENDING") pending++;
    proposals.push(raw as unknown as CustomerCompletionProposal);
  }
  if (
    pending > 1 ||
    (pending === 1 && proposals[0]?.outcome !== "PENDING") ||
    (proposals.length > 0 && proposals.at(-1)?.proposalNumber !== 1) ||
    new Set(proposals.map((proposal) => proposal.id)).size !== proposals.length
  )
    return null;
  return proposals;
}

export async function loadCustomerCompletionProposals(input: {
  fetch: typeof fetch;
  jobId: string;
}): Promise<ProposalLoad> {
  if (!uuid.test(input.jobId)) return { status: "UNAVAILABLE" };
  try {
    const response = await input.fetch.call(
      globalThis,
      `/v1/me/jobs/${input.jobId}/completion/proposals`,
      {
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const proposals = parseCustomerCompletionProposals(await response.json());
    return proposals ? { status: "OK", proposals } : { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

export type CustomerCompletionProposalCommand =
  | { readonly kind: "PROPOSE"; readonly note?: string | null }
  | { readonly kind: "AGREE"; readonly proposalId: string }
  | {
      readonly kind: "DISAGREE";
      readonly proposalId: string;
      readonly reason: string;
    };
export type ProposalCommandResult =
  | { readonly status: "OK"; readonly proposalId: string }
  | {
      readonly status:
        "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";
    };

export async function sendCustomerCompletionProposalCommand(input: {
  fetch: typeof fetch;
  jobId: string;
  commandId: string;
  command: CustomerCompletionProposalCommand;
}): Promise<ProposalCommandResult> {
  if (
    !uuid.test(input.jobId) ||
    !uuid.test(input.commandId) ||
    (input.command.kind === "PROPOSE"
      ? input.command.note !== undefined &&
        input.command.note !== null &&
        !text(input.command.note, 1, 1000)
      : !uuid.test(input.command.proposalId) ||
        (input.command.kind === "DISAGREE" &&
          !text(input.command.reason, 8, 1000)))
  )
    return { status: "UNAVAILABLE" };
  try {
    const csrfResponse = await input.fetch.call(globalThis, "/v1/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (csrfResponse.status === 401) return { status: "AUTH_REQUIRED" };
    if (!csrfResponse.ok) return { status: "UNAVAILABLE" };
    const csrf: unknown = await csrfResponse.json();
    if (
      !record(csrf) ||
      !exact(csrf, ["csrfToken"]) ||
      !text(csrf.csrfToken, 1, 1000)
    )
      return { status: "UNAVAILABLE" };
    const path =
      input.command.kind === "PROPOSE"
        ? `/v1/me/jobs/${input.jobId}/completion/proposals`
        : `/v1/me/jobs/${input.jobId}/completion/proposals/${input.command.proposalId}/${input.command.kind.toLowerCase()}`;
    const fields =
      input.command.kind === "PROPOSE"
        ? { note: input.command.note }
        : input.command.kind === "DISAGREE"
          ? { reason: input.command.reason }
          : {};
    const response = await input.fetch.call(globalThis, path, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrf.csrfToken,
      },
      body: JSON.stringify({ commandId: input.commandId, ...fields }),
    });
    if (response.status === 401) return { status: "AUTH_REQUIRED" };
    if (response.status === 404) return { status: "NOT_FOUND" };
    if (response.status === 409) return { status: "CONFLICT" };
    if (!response.ok) return { status: "UNAVAILABLE" };
    const result: unknown = await response.json();
    if (
      !record(result) ||
      !exact(result, ["status", "proposalId", "recordedAt"]) ||
      !["APPLIED", "DEDUPLICATED"].includes(String(result.status)) ||
      typeof result.proposalId !== "string" ||
      !uuid.test(result.proposalId) ||
      !instant(result.recordedAt)
    )
      return { status: "UNAVAILABLE" };
    return { status: "OK", proposalId: result.proposalId };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}
