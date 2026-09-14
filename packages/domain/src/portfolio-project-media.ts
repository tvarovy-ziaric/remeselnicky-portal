import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import type { PortfolioProjectId } from "./portfolio-project.js";
import type { UserId } from "./user.js";

export const PORTFOLIO_PHOTO_PHASES = Object.freeze([
  "BEFORE",
  "PROGRESS",
  "AFTER",
  "OTHER",
] as const);
export const PORTFOLIO_PROJECT_MAX_PHOTOS = 15;
export const PORTFOLIO_PHOTO_STATES = Object.freeze([
  "ACTIVE",
  "HIDDEN",
] as const);

export type PortfolioPhotoPhase = (typeof PORTFOLIO_PHOTO_PHASES)[number];
export type PortfolioPhotoState = (typeof PORTFOLIO_PHOTO_STATES)[number];

declare const portfolioProjectPhotoAttachmentIdBrand: unique symbol;
export type PortfolioProjectPhotoAttachmentId = EntityId & {
  readonly [portfolioProjectPhotoAttachmentIdBrand]: "PortfolioProjectPhotoAttachmentId";
};

export interface PortfolioProjectPhoto {
  readonly attachmentId: PortfolioProjectPhotoAttachmentId;
  readonly mediaAssetId: string;
  readonly phase: PortfolioPhotoPhase;
  readonly state: PortfolioPhotoState;
  /** One-based private display order; hidden attachments have no order. */
  readonly order: number | null;
  readonly capturedAt: Date | null;
  readonly canonicalWidth: number;
  readonly canonicalHeight: number;
  readonly attachedAt: Date;
}

export interface PortfolioProjectPhotoSet {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly revision: number;
  readonly photos: readonly PortfolioProjectPhoto[];
  readonly updatedAt: Date;
}

interface PortfolioPhotoCommandContext {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly expectedRevision: number;
}

export interface AttachPortfolioProjectPhotoInput extends PortfolioPhotoCommandContext {
  readonly attachmentId: PortfolioProjectPhotoAttachmentId;
  readonly mediaAssetId: string;
  readonly phase?: PortfolioPhotoPhase;
}

export interface ReorderPortfolioProjectPhotosInput extends PortfolioPhotoCommandContext {
  readonly orderedAttachmentIds: readonly PortfolioProjectPhotoAttachmentId[];
}

export interface SetPortfolioProjectPhotoPhaseInput extends PortfolioPhotoCommandContext {
  readonly attachmentId: PortfolioProjectPhotoAttachmentId;
  readonly phase: PortfolioPhotoPhase;
}

export interface HidePortfolioProjectPhotoInput extends PortfolioPhotoCommandContext {
  readonly attachmentId: PortfolioProjectPhotoAttachmentId;
}

export interface RestorePortfolioProjectPhotoInput extends PortfolioPhotoCommandContext {
  readonly attachmentId: PortfolioProjectPhotoAttachmentId;
}

export interface ListPortfolioProjectPhotosInput {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
}

export type PortfolioPhotoCommandResult = Readonly<
  | {
      readonly status: "APPLIED" | "DEDUPLICATED";
      readonly photoSet: PortfolioProjectPhotoSet;
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "PROJECT_UNAVAILABLE"
        | "PROJECT_ARCHIVED"
        | "MEDIA_UNAVAILABLE"
        | "PHOTO_UNAVAILABLE"
        | "PHOTO_ALREADY_ATTACHED"
        | "PHOTO_LIMIT_REACHED"
        | "INVALID_ORDER"
        | "STALE_REVISION"
        | "UNCHANGED";
    }
>;

export interface PortfolioProjectPhotoPersistence {
  attach(
    input: AttachPortfolioProjectPhotoInput,
  ): Promise<PortfolioPhotoCommandResult>;
  reorder(
    input: ReorderPortfolioProjectPhotosInput,
  ): Promise<PortfolioPhotoCommandResult>;
  setPhase(
    input: SetPortfolioProjectPhotoPhaseInput,
  ): Promise<PortfolioPhotoCommandResult>;
  hide(
    input: HidePortfolioProjectPhotoInput,
  ): Promise<PortfolioPhotoCommandResult>;
  restore(
    input: RestorePortfolioProjectPhotoInput,
  ): Promise<PortfolioPhotoCommandResult>;
  listOwned(
    input: ListPortfolioProjectPhotosInput,
  ): Promise<PortfolioProjectPhotoSet | null>;
}

export class PortfolioProjectPhotoValidationError extends TypeError {
  readonly code = "INVALID_PORTFOLIO_PROJECT_PHOTO_COMMAND";
}

export function assertAttachPortfolioProjectPhotoInput(
  input: AttachPortfolioProjectPhotoInput,
): void {
  assertContext(input);
  assertUuid(input.attachmentId, "attachmentId");
  assertUuid(input.mediaAssetId, "mediaAssetId");
  if (input.phase !== undefined) assertPhase(input.phase);
}

export function assertReorderPortfolioProjectPhotosInput(
  input: ReorderPortfolioProjectPhotosInput,
): void {
  assertContext(input);
  assertAttachmentIds(input.orderedAttachmentIds, true);
}

export function assertSetPortfolioProjectPhotoPhaseInput(
  input: SetPortfolioProjectPhotoPhaseInput,
): void {
  assertContext(input);
  assertUuid(input.attachmentId, "attachmentId");
  assertPhase(input.phase);
}

export function assertHidePortfolioProjectPhotoInput(
  input: HidePortfolioProjectPhotoInput,
): void {
  assertContext(input);
  assertUuid(input.attachmentId, "attachmentId");
}

export function assertRestorePortfolioProjectPhotoInput(
  input: RestorePortfolioProjectPhotoInput,
): void {
  assertContext(input);
  assertUuid(input.attachmentId, "attachmentId");
}

export function assertListPortfolioProjectPhotosInput(
  input: ListPortfolioProjectPhotosInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
  assertUuid(input.portfolioProjectId, "portfolioProjectId");
}

function assertContext(input: PortfolioPhotoCommandContext): void {
  assertListPortfolioProjectPhotosInput(input);
  assertUuid(input.commandId, "commandId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw invalid("expectedRevision");
  }
}

function assertAttachmentIds(
  values: readonly PortfolioProjectPhotoAttachmentId[],
  allowEmpty: boolean,
): void {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.length > PORTFOLIO_PROJECT_MAX_PHOTOS ||
    new Set(values).size !== values.length
  ) {
    throw invalid("orderedAttachmentIds");
  }
  for (const value of values as readonly unknown[]) {
    if (typeof value !== "string") throw invalid("orderedAttachmentIds");
    assertUuid(value, "orderedAttachmentIds");
  }
}

function assertPhase(value: PortfolioPhotoPhase): void {
  if (!PORTFOLIO_PHOTO_PHASES.some((phase) => phase === value)) {
    throw invalid("phase");
  }
}

function assertUuid(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function invalid(field: string): PortfolioProjectPhotoValidationError {
  return new PortfolioProjectPhotoValidationError(
    `Invalid portfolio project photo command field: ${field}.`,
  );
}
