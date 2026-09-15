import {
  normalizeJobRequestContentSection,
  type JobRequestContentSection,
} from "./job-request-content.js";
import type { JobRequestDraftSectionInput } from "./job-request-draft.js";
import type { JobRequestId } from "./job-request.js";
import type { UserId } from "./user.js";

export const JOB_REQUEST_MATERIAL_CHANGE_CATEGORIES = Object.freeze([
  "ATTACHMENTS",
  "BUDGET",
  "LOCATION",
  "MATERIAL_RESPONSIBILITY",
  "OTHER_REQUIREMENTS",
  "PROFESSION",
  "SCHEDULE",
  "SCOPE",
] as const);

export type JobRequestMaterialChangeCategory =
  (typeof JOB_REQUEST_MATERIAL_CHANGE_CATEGORIES)[number];

export interface JobRequestChangeClassification {
  readonly categories: readonly JobRequestMaterialChangeCategory[];
  readonly changed: boolean;
  readonly material: boolean;
}

export interface JobRequestActiveContentVersion {
  readonly categories: readonly JobRequestMaterialChangeCategory[];
  readonly changedAt: Date;
  readonly contentRevision: number;
  readonly jobRequestId: JobRequestId;
  readonly material: boolean;
  readonly visibleVersion: number;
}

export interface ReviseActiveJobRequestInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly expectedContentRevision: number;
  readonly jobRequestId: JobRequestId;
  readonly section: JobRequestDraftSectionInput;
}

export interface PersistReviseActiveJobRequestInput extends Omit<
  ReviseActiveJobRequestInput,
  "section"
> {
  readonly section: JobRequestContentSection;
}

export type ReviseActiveJobRequestResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED" | "UNCHANGED";
      readonly version: JobRequestActiveContentVersion;
    }
  | {
      readonly currentContentRevision?: number;
      readonly status:
        | "ACCOUNT_NOT_ACTIVE"
        | "INVALID_TRANSITION"
        | "NOT_FOUND"
        | "STALE_REVISION";
    }
>;

export interface JobRequestVersionPersistence {
  reviseActiveOwned(
    input: PersistReviseActiveJobRequestInput,
  ): Promise<ReviseActiveJobRequestResult>;
}

export interface JobRequestVersionService {
  reviseActive(
    input: ReviseActiveJobRequestInput,
  ): Promise<ReviseActiveJobRequestResult>;
}

export class JobRequestVersionIdempotencyError extends Error {
  readonly code = "JOB_REQUEST_VERSION_IDEMPOTENCY_CONFLICT";
}

export function createJobRequestVersionService(input: {
  readonly persistence: JobRequestVersionPersistence;
}): JobRequestVersionService {
  return Object.freeze({
    reviseActive(command: ReviseActiveJobRequestInput) {
      assertReviseActiveJobRequestInput(command);
      return input.persistence.reviseActiveOwned({
        ...command,
        section: normalizeJobRequestContentSection(command.section),
      });
    },
  });
}

export function assertReviseActiveJobRequestInput(
  input: ReviseActiveJobRequestInput,
): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Invalid active job request revision command.");
  }
  for (const value of [
    input.actorUserId,
    input.commandId,
    input.jobRequestId,
  ]) {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      )
    ) {
      throw new TypeError("Invalid active job request revision identity.");
    }
  }
  if (
    !Number.isSafeInteger(input.expectedContentRevision) ||
    input.expectedContentRevision < 1
  ) {
    throw new TypeError("Invalid active job request content revision.");
  }
  normalizeJobRequestContentSection(input.section);
}

/**
 * Conservative server-side classification. Only an isolated title edit is
 * minor; any field that can affect price or willingness is material.
 */
export function classifyJobRequestChange(
  previousInput: JobRequestDraftSectionInput,
  nextInput: JobRequestDraftSectionInput,
): JobRequestChangeClassification {
  const previous = normalizeJobRequestContentSection(previousInput);
  const next = normalizeJobRequestContentSection(nextInput);
  if (previous.key !== next.key) {
    throw new TypeError("Job request change must compare the same section.");
  }
  if (previous.canonicalPayload === next.canonicalPayload) {
    return Object.freeze({ categories: [], changed: false, material: false });
  }
  const categories = categoriesFor(previous, next);
  return Object.freeze({
    categories: Object.freeze([...new Set(categories)].sort(codePointCompare)),
    changed: true,
    material: categories.length > 0,
  });
}

function categoriesFor(
  previous: JobRequestContentSection,
  next: JobRequestContentSection,
): JobRequestMaterialChangeCategory[] {
  const before = previous.payload as unknown as Record<string, unknown>;
  const after = next.payload as unknown as Record<string, unknown>;
  switch (previous.key) {
    case "request.core": {
      const categories: JobRequestMaterialChangeCategory[] = [];
      if (
        different(
          before["primaryProfessionCode"],
          after["primaryProfessionCode"],
        )
      ) {
        categories.push("PROFESSION");
      }
      if (
        [
          "description",
          "relatedProfessionCodes",
          "skillCodes",
          "specializationCode",
        ].some((field) => different(before[field], after[field]))
      ) {
        categories.push("SCOPE");
      }
      return categories;
    }
    case "request.location":
      return ["LOCATION"];
    case "request.timing":
      return ["SCHEDULE"];
    case "request.budget":
      return ["BUDGET"];
    case "request.media":
      return ["ATTACHMENTS"];
    case "request.details": {
      const categories: JobRequestMaterialChangeCategory[] = [];
      if (
        different(
          before["materialResponsibility"],
          after["materialResponsibility"],
        )
      ) {
        categories.push("MATERIAL_RESPONSIBILITY");
      }
      if (
        ["approximateQuantity", "siteInspection"].some((field) =>
          different(before[field], after[field]),
        )
      ) {
        categories.push("SCOPE");
      }
      if (
        different(before["customRequirements"], after["customRequirements"])
      ) {
        categories.push("OTHER_REQUIREMENTS");
      }
      return categories;
    }
    default:
      throw new TypeError("Unsupported job request content section.");
  }
}

function different(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
