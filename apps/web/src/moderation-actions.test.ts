import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModerationBoundaryNotice, parseActions } from "./moderation-actions";

const action = {
  actionId: "aa230000-0000-4000-8000-000000000005",
  action: "HIDE_CONTENT",
  targetType: "MESSAGE",
  targetId: "aa230000-0000-4000-8000-000000000007",
  enforcementScope: "CONTENT",
  restrictionExpiresAt: null,
  policyCategory: "HARASSMENT_ABUSE",
  userFacingReason: "Správa bola skrytá pre porušenie pravidiel.",
  appliedAt: "2026-09-24T10:00:00.000Z",
  active: true,
  appealId: null,
  appealState: null,
};

describe("moderation action projection", () => {
  it("keeps appeals history-preserving and separate from commercial disputes", () => {
    const html = renderToStaticMarkup(
      React.createElement(ModerationBoundaryNotice),
    );
    expect(html).toContain("Odvolanie opatrenie automaticky neruší");
    expect(html).toContain("bežný spor o cenu alebo kvalitu práce");
    expect(html).toContain("sporného prípadu");
  });

  it("accepts only the privacy-minimal user-facing action shape", () => {
    expect(parseActions({ items: [action] })).toEqual([action]);
    expect(parseActions({ items: [{ ...action, active: "yes" }] })).toBeNull();
    expect(
      parseActions({ items: [{ ...action, appealState: "AUTO_LIFTED" }] }),
    ).toBeNull();
  });
});
