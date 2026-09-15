import type { JobRequestContentSection } from "./job-request-content.js";
import type { JobRequest, JobRequestId } from "./job-request.js";
import type { UserId } from "./user.js";

export const JOB_REQUEST_CANCELLATION_REASONS = Object.freeze([
  "DUPLICATE",
  "NO_LONGER_NEEDED",
  "OTHER",
  "PLANS_CHANGED",
] as const);
export const JOB_REQUEST_DEFAULT_ACTIVE_LIMIT = 5;
export const JOB_REQUEST_DEFAULT_INACTIVITY_DAYS = 30;

export type JobRequestCancellationReason =
  (typeof JOB_REQUEST_CANCELLATION_REASONS)[number];

export interface JobRequestLifecycleCommandInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly jobRequestId: JobRequestId;
}

export interface CancelJobRequestInput extends JobRequestLifecycleCommandInput {
  readonly reason: JobRequestCancellationReason;
}

export interface DuplicateJobRequestInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly sourceJobRequestId: JobRequestId;
}

export interface JobRequestLifecycleRecord extends JobRequest {
  readonly cancellationReason: JobRequestCancellationReason | null;
  readonly expiresAt: Date | null;
  readonly warningAt: Date | null;
}

export type JobRequestLifecycleListResult = Readonly<
  | {
      readonly requests: readonly JobRequestLifecycleRecord[];
      readonly status: "OK";
    }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" }
>;

export type JobRequestLifecycleCommandResult = Readonly<
  | {
      readonly jobRequest: JobRequestLifecycleRecord;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly activeLimit?: number;
      readonly currentRevision?: number;
      readonly status:
        | "ACCOUNT_NOT_ACTIVE"
        | "ACTIVE_LIMIT_REACHED"
        | "INVALID_TRANSITION"
        | "NOT_FOUND"
        | "NOT_READY"
        | "STALE_REVISION";
    }
>;

export type DuplicateJobRequestResult = Readonly<
  | {
      readonly jobRequestId: JobRequestId;
      readonly revision: number;
      readonly sections: readonly JobRequestContentSection[];
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | { readonly status: "ACCOUNT_NOT_ACTIVE" | "NOT_FOUND" }
>;

export interface JobRequestLifecyclePersistence {
  cancelOwned(
    input: CancelJobRequestInput,
  ): Promise<JobRequestLifecycleCommandResult>;
  duplicateOwned(
    input: DuplicateJobRequestInput,
  ): Promise<DuplicateJobRequestResult>;
  expireInactive(): Promise<readonly JobRequestId[]>;
  listOwned(actorUserId: UserId): Promise<JobRequestLifecycleListResult>;
  extendOwned(
    input: JobRequestLifecycleCommandInput,
  ): Promise<JobRequestLifecycleCommandResult>;
  reactivateOwned(
    input: JobRequestLifecycleCommandInput,
  ): Promise<JobRequestLifecycleCommandResult>;
}

export interface JobRequestLifecycleService {
  cancel(
    input: CancelJobRequestInput,
  ): Promise<JobRequestLifecycleCommandResult>;
  duplicate(
    input: DuplicateJobRequestInput,
  ): Promise<DuplicateJobRequestResult>;
  extend(
    input: JobRequestLifecycleCommandInput,
  ): Promise<JobRequestLifecycleCommandResult>;
  list(actorUserId: UserId): Promise<JobRequestLifecycleListResult>;
  reactivate(
    input: JobRequestLifecycleCommandInput,
  ): Promise<JobRequestLifecycleCommandResult>;
}

export class JobRequestLifecycleIdempotencyError extends Error {
  readonly code = "JOB_REQUEST_LIFECYCLE_IDEMPOTENCY_CONFLICT";
}

export function createJobRequestLifecycleService(input: {
  readonly persistence: JobRequestLifecyclePersistence;
}): JobRequestLifecycleService {
  return Object.freeze({
    cancel(command: CancelJobRequestInput) {
      assertCancelJobRequestInput(command);
      return input.persistence.cancelOwned(command);
    },
    duplicate(command: DuplicateJobRequestInput) {
      assertDuplicateJobRequestInput(command);
      return input.persistence.duplicateOwned(command);
    },
    extend(command: JobRequestLifecycleCommandInput) {
      assertJobRequestLifecycleCommandInput(command);
      return input.persistence.extendOwned(command);
    },
    list(actorUserId: UserId) {
      assertUuid(actorUserId, "actorUserId");
      return input.persistence.listOwned(actorUserId);
    },
    reactivate(command: JobRequestLifecycleCommandInput) {
      assertJobRequestLifecycleCommandInput(command);
      return input.persistence.reactivateOwned(command);
    },
  });
}

export function assertJobRequestLifecycleCommandInput(
  input: JobRequestLifecycleCommandInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.jobRequestId, "jobRequestId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw new TypeError("Invalid job request lifecycle revision.");
  }
}

export function assertCancelJobRequestInput(
  input: CancelJobRequestInput,
): void {
  assertJobRequestLifecycleCommandInput(input);
  if (
    !JOB_REQUEST_CANCELLATION_REASONS.some((reason) => reason === input.reason)
  ) {
    throw new TypeError("Invalid job request cancellation reason.");
  }
}

export function assertDuplicateJobRequestInput(
  input: DuplicateJobRequestInput,
): void {
  assertRecord(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.sourceJobRequestId, "sourceJobRequestId");
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid job request lifecycle command.");
  }
}

function assertUuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new TypeError(`Invalid job request lifecycle ${field}.`);
  }
}
