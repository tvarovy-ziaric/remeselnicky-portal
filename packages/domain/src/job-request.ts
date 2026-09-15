import type {
  CustomerProfileId,
  CustomerProfileService,
} from "./customer-profile.js";
import type { EntityId } from "./index.js";
import type { UserId } from "./user.js";

declare const jobRequestIdBrand: unique symbol;

export type JobRequestId = EntityId & {
  readonly [jobRequestIdBrand]: "JobRequestId";
};

export const JOB_REQUEST_STATES = Object.freeze([
  "DRAFT",
  "ACTIVE",
  "EXPIRED",
  "CANCELLED",
] as const);
export const JOB_REQUEST_SUBMISSION_REQUIREMENTS = Object.freeze([
  "PRIMARY_PROFESSION",
  "DESCRIPTION",
  "MUNICIPALITY",
] as const);

export type JobRequestState = (typeof JOB_REQUEST_STATES)[number];
export type JobRequestSubmissionRequirement =
  (typeof JOB_REQUEST_SUBMISSION_REQUIREMENTS)[number];

export interface JobRequest {
  readonly activatedAt: Date | null;
  readonly changedAt: Date;
  readonly createdAt: Date;
  readonly customerProfileId: CustomerProfileId;
  readonly id: JobRequestId;
  readonly revision: number;
  readonly state: JobRequestState;
}

export interface CreateJobRequestDraftInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
}

export interface PersistCreateJobRequestDraftInput extends CreateJobRequestDraftInput {
  readonly customerProfileId: CustomerProfileId;
}

export interface ActivateJobRequestInput {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly jobRequestId: JobRequestId;
}

export type JobRequestCommandResult = Readonly<
  | {
      readonly jobRequest: JobRequest;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly activeLimit?: number;
      readonly missingRequirements?: readonly JobRequestSubmissionRequirement[];
      readonly status:
        | "ACCOUNT_NOT_ACTIVE"
        | "ACTIVE_LIMIT_REACHED"
        | "INVALID_TRANSITION"
        | "NOT_FOUND"
        | "NOT_READY"
        | "STALE_REVISION";
    }
>;

export interface JobRequestPersistence {
  activateOwned(
    input: ActivateJobRequestInput,
  ): Promise<JobRequestCommandResult>;
  createDraftOwned(
    input: PersistCreateJobRequestDraftInput,
  ): Promise<JobRequestCommandResult>;
}

export interface JobRequestService {
  activate(input: ActivateJobRequestInput): Promise<JobRequestCommandResult>;
  createDraft(
    input: CreateJobRequestDraftInput,
  ): Promise<JobRequestCommandResult>;
}

export class JobRequestIdempotencyError extends Error {
  readonly code = "JOB_REQUEST_IDEMPOTENCY_CONFLICT";
}

export class JobRequestValidationError extends TypeError {
  readonly code = "INVALID_JOB_REQUEST_COMMAND";
}

export function createJobRequestService(input: {
  readonly customerProfiles: CustomerProfileService;
  readonly persistence: JobRequestPersistence;
}): JobRequestService {
  return Object.freeze({
    activate(command: ActivateJobRequestInput) {
      assertActivateJobRequestInput(command);
      return input.persistence.activateOwned(command);
    },
    async createDraft(command: CreateJobRequestDraftInput) {
      assertCreateJobRequestDraftInput(command);
      const customer = await input.customerProfiles.ensureForCustomerUse(
        command.actorUserId,
      );
      return input.persistence.createDraftOwned({
        ...command,
        customerProfileId: customer.profile.id,
      });
    },
  });
}

export function transitionJobRequest(
  current: JobRequestState,
  command: "ACTIVATE" | "CANCEL" | "EXPIRE" | "EXTEND" | "REACTIVATE",
): JobRequestState | null {
  if (command === "ACTIVATE" && current === "DRAFT") return "ACTIVE";
  if (command === "EXTEND" && current === "ACTIVE") return "ACTIVE";
  if (command === "EXPIRE" && current === "ACTIVE") return "EXPIRED";
  if (command === "REACTIVATE" && current === "EXPIRED") return "ACTIVE";
  if (command === "CANCEL" && current === "ACTIVE") return "CANCELLED";
  return null;
}

export function assertCreateJobRequestDraftInput(
  input: CreateJobRequestDraftInput,
): void {
  assertObject(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
}

export function assertActivateJobRequestInput(
  input: ActivateJobRequestInput,
): void {
  assertObject(input);
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.jobRequestId, "jobRequestId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw invalid("expectedRevision");
  }
}

function assertObject(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("command");
  }
}

function assertUuid(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function invalid(field: string): JobRequestValidationError {
  return new JobRequestValidationError(
    `Invalid job request command field: ${field}.`,
  );
}
