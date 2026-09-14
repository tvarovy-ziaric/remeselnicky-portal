import { describe, expect, it } from "vitest";

import {
  assertAttachPortfolioProjectPhotoInput,
  assertHidePortfolioProjectPhotoInput,
  assertListPortfolioProjectPhotosInput,
  assertReorderPortfolioProjectPhotosInput,
  assertRestorePortfolioProjectPhotoInput,
  assertSetPortfolioProjectPhotoPhaseInput,
  PORTFOLIO_PHOTO_PHASES,
  PORTFOLIO_PHOTO_STATES,
  PORTFOLIO_PROJECT_MAX_PHOTOS,
  PortfolioProjectPhotoValidationError,
  type AttachPortfolioProjectPhotoInput,
  type PortfolioPhotoPhase,
  type PortfolioProjectPhotoAttachmentId,
} from "../src/portfolio-project-media.js";
import type { UserId } from "../src/user.js";

const actorUserId = "00000000-0000-4000-8000-000000000101";
const craftsmanProfileId = "00000000-0000-4000-8000-000000000102";
const portfolioProjectId = "00000000-0000-4000-8000-000000000103";
const commandId = "00000000-0000-4000-8000-000000000104";
const attachmentId = "00000000-0000-4000-8000-000000000105";
const mediaAssetId = "00000000-0000-4000-8000-000000000106";

describe("portfolio project photo domain boundary", () => {
  it("locks photo phases and the alpha maximum", () => {
    expect(PORTFOLIO_PHOTO_PHASES).toEqual([
      "BEFORE",
      "PROGRESS",
      "AFTER",
      "OTHER",
    ]);
    expect(PORTFOLIO_PROJECT_MAX_PHOTOS).toBe(15);
    expect(PORTFOLIO_PHOTO_STATES).toEqual(["ACTIVE", "HIDDEN"]);
  });

  it("accepts an owner command and defaults phase in persistence", () => {
    expect(() =>
      assertAttachPortfolioProjectPhotoInput(validAttach()),
    ).not.toThrow();
    for (const phase of PORTFOLIO_PHOTO_PHASES) {
      expect(() =>
        assertAttachPortfolioProjectPhotoInput(validAttach({ phase })),
      ).not.toThrow();
    }
  });

  it("rejects malformed IDs and revisions", () => {
    const invalidInputs: readonly AttachPortfolioProjectPhotoInput[] = [
      validAttach({ actorUserId: "other" as UserId }),
      validAttach({ commandId: "other" }),
      validAttach({
        attachmentId: "other" as PortfolioProjectPhotoAttachmentId,
      }),
      validAttach({ mediaAssetId: "other" }),
      validAttach({ expectedRevision: -1 }),
      validAttach({ expectedRevision: 1.2 }),
    ];
    for (const input of invalidInputs) {
      expect(() => assertAttachPortfolioProjectPhotoInput(input)).toThrow(
        PortfolioProjectPhotoValidationError,
      );
    }
  });

  it("rejects unknown phases", () => {
    expect(() =>
      assertAttachPortfolioProjectPhotoInput(
        validAttach({ phase: "DURING" as PortfolioPhotoPhase }),
      ),
    ).toThrow(PortfolioProjectPhotoValidationError);
  });

  it("requires a unique complete bounded reorder list", () => {
    expect(() =>
      assertReorderPortfolioProjectPhotosInput({
        ...context(),
        orderedAttachmentIds: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertReorderPortfolioProjectPhotosInput({
        ...context(),
        orderedAttachmentIds: [attachmentId, attachmentId] as never,
      }),
    ).toThrow(PortfolioProjectPhotoValidationError);
    expect(() =>
      assertReorderPortfolioProjectPhotosInput({
        ...context(),
        orderedAttachmentIds: Array.from(
          { length: PORTFOLIO_PROJECT_MAX_PHOTOS + 1 },
          (_, index) =>
            `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ) as never,
      }),
    ).toThrow(PortfolioProjectPhotoValidationError);
  });

  it("validates phase, hide and private list commands", () => {
    expect(() =>
      assertSetPortfolioProjectPhotoPhaseInput({
        ...context(),
        attachmentId: attachmentId as never,
        phase: "AFTER",
      }),
    ).not.toThrow();
    expect(() =>
      assertHidePortfolioProjectPhotoInput({
        ...context(),
        attachmentId: attachmentId as never,
      }),
    ).not.toThrow();
    expect(() =>
      assertRestorePortfolioProjectPhotoInput({
        ...context(),
        attachmentId: attachmentId as never,
      }),
    ).not.toThrow();
    expect(() =>
      assertListPortfolioProjectPhotosInput(context()),
    ).not.toThrow();
  });
});

function context() {
  return {
    actorUserId: actorUserId as never,
    commandId,
    craftsmanProfileId: craftsmanProfileId as never,
    expectedRevision: 0,
    portfolioProjectId: portfolioProjectId as never,
  };
}

function validAttach(
  changes: Partial<AttachPortfolioProjectPhotoInput> = {},
): AttachPortfolioProjectPhotoInput {
  return {
    ...context(),
    attachmentId: attachmentId as never,
    mediaAssetId,
    ...changes,
  };
}
