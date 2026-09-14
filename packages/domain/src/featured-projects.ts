import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { PortfolioProjectId } from "./portfolio-project.js";
import type { UserId } from "./user.js";

export const MAX_FEATURED_PROJECTS = 3;
export const FEATURED_PROJECT_AVAILABILITY = Object.freeze([
  "AVAILABLE",
  "UNAVAILABLE",
] as const);

export type FeaturedProjectAvailability =
  (typeof FEATURED_PROJECT_AVAILABILITY)[number];

export interface FeaturedProjectItem {
  readonly availability: FeaturedProjectAvailability;
  readonly position: number;
  readonly portfolioProjectId: PortfolioProjectId;
  /** Omitted fail-closed when the current project is no longer owned/available. */
  readonly title: string | null;
}

export interface FeaturedProjectSet {
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly items: readonly FeaturedProjectItem[];
  readonly revision: number;
  readonly updatedAt: Date;
}

interface FeaturedProjectCommandContext {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly craftsmanProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
}

export interface PinFeaturedProjectInput extends FeaturedProjectCommandContext {
  readonly portfolioProjectId: PortfolioProjectId;
}

export interface UnpinFeaturedProjectInput extends FeaturedProjectCommandContext {
  readonly portfolioProjectId: PortfolioProjectId;
}

export interface ReorderFeaturedProjectsInput extends FeaturedProjectCommandContext {
  readonly orderedPortfolioProjectIds: readonly PortfolioProjectId[];
}

export interface ListOwnedFeaturedProjectsInput {
  readonly actorUserId: UserId;
  readonly craftsmanProfileId: CraftsmanProfileId;
}

export type FeaturedProjectCommandResult = Readonly<
  | {
      readonly featured: FeaturedProjectSet;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly status:
        | "PROFILE_UNAVAILABLE"
        | "PROJECT_UNAVAILABLE"
        | "PROJECT_ALREADY_FEATURED"
        | "PROJECT_NOT_FEATURED"
        | "FEATURED_LIMIT_REACHED"
        | "INVALID_ORDER"
        | "STALE_REVISION"
        | "UNCHANGED";
    }
>;

export interface FeaturedProjectPersistence {
  pin(input: PinFeaturedProjectInput): Promise<FeaturedProjectCommandResult>;
  unpin(
    input: UnpinFeaturedProjectInput,
  ): Promise<FeaturedProjectCommandResult>;
  reorder(
    input: ReorderFeaturedProjectsInput,
  ): Promise<FeaturedProjectCommandResult>;
  listOwned(
    input: ListOwnedFeaturedProjectsInput,
  ): Promise<FeaturedProjectSet | null>;
}

export class FeaturedProjectValidationError extends TypeError {
  readonly code = "INVALID_FEATURED_PROJECT_COMMAND";
}

export function assertPinFeaturedProjectInput(
  input: PinFeaturedProjectInput,
): void {
  assertContext(input);
  assertUuid(input.portfolioProjectId, "portfolioProjectId");
}

export function assertUnpinFeaturedProjectInput(
  input: UnpinFeaturedProjectInput,
): void {
  assertContext(input);
  assertUuid(input.portfolioProjectId, "portfolioProjectId");
}

export function assertReorderFeaturedProjectsInput(
  input: ReorderFeaturedProjectsInput,
): void {
  assertContext(input);
  assertProjectIds(input.orderedPortfolioProjectIds);
}

export function assertListOwnedFeaturedProjectsInput(
  input: ListOwnedFeaturedProjectsInput,
): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.craftsmanProfileId, "craftsmanProfileId");
}

function assertContext(input: FeaturedProjectCommandContext): void {
  assertListOwnedFeaturedProjectsInput(input);
  assertUuid(input.commandId, "commandId");
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw invalid("expectedRevision");
  }
}

function assertProjectIds(values: readonly PortfolioProjectId[]): void {
  if (
    !Array.isArray(values) ||
    values.length > MAX_FEATURED_PROJECTS ||
    new Set(values).size !== values.length
  ) {
    throw invalid("orderedPortfolioProjectIds");
  }
  for (const value of values as readonly unknown[]) {
    if (typeof value !== "string") throw invalid("orderedPortfolioProjectIds");
    assertUuid(value, "orderedPortfolioProjectIds");
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

function invalid(field: string): FeaturedProjectValidationError {
  return new FeaturedProjectValidationError(
    `Invalid featured project command field: ${field}.`,
  );
}
