import type { CraftsmanProfileId } from "./craftsman-profile.js";
import type { EntityId } from "./index.js";
import {
  isPortfolioProjectPublicTextSafe,
  type PortfolioProjectId,
} from "./portfolio-project.js";
import type { UserId } from "./user.js";

export const PORTFOLIO_COLLABORATION_STATES = Object.freeze([
  "PENDING",
  "ACCEPTED",
  "DECLINED",
  "AUTHOR_WITHDRAWN",
  "COLLABORATOR_WITHDRAWN",
] as const);
export const PORTFOLIO_COLLABORATION_VISIBILITIES = Object.freeze([
  "VISIBLE",
  "HIDDEN",
] as const);

export type PortfolioCollaborationState =
  (typeof PORTFOLIO_COLLABORATION_STATES)[number];
export type PortfolioCollaborationVisibility =
  (typeof PORTFOLIO_COLLABORATION_VISIBILITIES)[number];

declare const portfolioCollaborationIdBrand: unique symbol;
export type PortfolioCollaborationId = EntityId & {
  readonly [portfolioCollaborationIdBrand]: "PortfolioCollaborationId";
};

export interface PortfolioCollaboration {
  readonly id: PortfolioCollaborationId;
  readonly portfolioProjectId: PortfolioProjectId;
  readonly authorProfileId: CraftsmanProfileId;
  readonly collaboratorProfileId: CraftsmanProfileId;
  readonly state: PortfolioCollaborationState;
  readonly visibility: PortfolioCollaborationVisibility;
  readonly role: string;
  readonly contribution: string;
  readonly revision: number;
  readonly invitedAt: Date;
  readonly acceptedAt: Date | null;
  readonly terminalAt: Date | null;
  readonly updatedAt: Date;
}

interface PortfolioCollaborationCommandIdentity {
  readonly actorUserId: UserId;
  readonly commandId: string;
  readonly collaborationId: PortfolioCollaborationId;
  readonly portfolioProjectId: PortfolioProjectId;
}

export interface InvitePortfolioCollaboratorInput extends PortfolioCollaborationCommandIdentity {
  readonly authorProfileId: CraftsmanProfileId;
  readonly collaboratorProfileId: CraftsmanProfileId;
  readonly role: string;
  readonly contribution: string;
}

export interface EditPendingPortfolioCollaborationInput extends PortfolioCollaborationCommandIdentity {
  readonly expectedRevision: number;
  readonly role: string;
  readonly contribution: string;
}

export interface AuthorPortfolioCollaborationStateInput extends PortfolioCollaborationCommandIdentity {
  readonly expectedRevision: number;
}

export interface CollaboratorPortfolioCollaborationStateInput extends PortfolioCollaborationCommandIdentity {
  readonly collaboratorProfileId: CraftsmanProfileId;
  readonly expectedRevision: number;
}

export type PortfolioCollaborationCommandResult = Readonly<
  | {
      readonly collaboration: PortfolioCollaboration;
      readonly status: "APPLIED" | "DEDUPLICATED";
    }
  | {
      readonly status:
        | "COLLABORATION_UNAVAILABLE"
        | "DUPLICATE_ACTIVE_INVITATION"
        | "INVALID_TRANSITION"
        | "STALE_REVISION"
        | "UNCHANGED";
    }
>;

export interface PortfolioCollaborationPersistence {
  invite(
    input: InvitePortfolioCollaboratorInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  editPending(
    input: EditPendingPortfolioCollaborationInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  withdrawPending(
    input: AuthorPortfolioCollaborationStateInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  hide(
    input: AuthorPortfolioCollaborationStateInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  show(
    input: AuthorPortfolioCollaborationStateInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  accept(
    input: CollaboratorPortfolioCollaborationStateInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  decline(
    input: CollaboratorPortfolioCollaborationStateInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  withdrawAccepted(
    input: CollaboratorPortfolioCollaborationStateInput,
  ): Promise<PortfolioCollaborationCommandResult>;
  listOwnedAsAuthor(input: {
    readonly actorUserId: UserId;
    readonly authorProfileId: CraftsmanProfileId;
    readonly portfolioProjectId: PortfolioProjectId;
  }): Promise<readonly PortfolioCollaboration[]>;
  listOwnedAsCollaborator(input: {
    readonly actorUserId: UserId;
    readonly collaboratorProfileId: CraftsmanProfileId;
  }): Promise<readonly PortfolioCollaboration[]>;
}

export class PortfolioCollaborationValidationError extends TypeError {
  readonly code = "INVALID_PORTFOLIO_COLLABORATION_COMMAND";
}

export function assertInvitePortfolioCollaboratorInput(
  input: InvitePortfolioCollaboratorInput,
): void {
  assertIdentity(input);
  assertUuid(input.authorProfileId, "authorProfileId");
  assertUuid(input.collaboratorProfileId, "collaboratorProfileId");
  if (input.authorProfileId === input.collaboratorProfileId) {
    throw invalid("collaboratorProfileId");
  }
  assertAttribution(input);
}

export function assertEditPendingPortfolioCollaborationInput(
  input: EditPendingPortfolioCollaborationInput,
): void {
  assertIdentity(input);
  assertRevision(input.expectedRevision);
  assertAttribution(input);
}

export function assertAuthorPortfolioCollaborationStateInput(
  input: AuthorPortfolioCollaborationStateInput,
): void {
  assertIdentity(input);
  assertRevision(input.expectedRevision);
}

export function assertCollaboratorPortfolioCollaborationStateInput(
  input: CollaboratorPortfolioCollaborationStateInput,
): void {
  assertIdentity(input);
  assertUuid(input.collaboratorProfileId, "collaboratorProfileId");
  assertRevision(input.expectedRevision);
}

export function assertPortfolioCollaborationAuthorListInput(input: {
  readonly actorUserId: UserId;
  readonly authorProfileId: CraftsmanProfileId;
  readonly portfolioProjectId: PortfolioProjectId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.authorProfileId, "authorProfileId");
  assertUuid(input.portfolioProjectId, "portfolioProjectId");
}

export function assertPortfolioCollaborationCollaboratorListInput(input: {
  readonly actorUserId: UserId;
  readonly collaboratorProfileId: CraftsmanProfileId;
}): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.collaboratorProfileId, "collaboratorProfileId");
}

function assertIdentity(input: PortfolioCollaborationCommandIdentity): void {
  assertUuid(input.actorUserId, "actorUserId");
  assertUuid(input.commandId, "commandId");
  assertUuid(input.collaborationId, "collaborationId");
  assertUuid(input.portfolioProjectId, "portfolioProjectId");
}

function assertAttribution(input: {
  readonly role: string;
  readonly contribution: string;
}): void {
  assertPublicText(input.role, 2, 120, "role");
  assertPublicText(input.contribution, 2, 600, "contribution");
}

function assertPublicText(
  value: string,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (
    value !== value.trim() ||
    value.length < minimum ||
    value.length > maximum ||
    !isPortfolioProjectPublicTextSafe(value)
  ) {
    throw invalid(field);
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid("expectedRevision");
  }
}

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw invalid(field);
  }
}

function invalid(field: string): PortfolioCollaborationValidationError {
  return new PortfolioCollaborationValidationError(
    `Invalid portfolio collaboration field: ${field}.`,
  );
}
