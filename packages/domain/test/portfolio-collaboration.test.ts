import { describe, expect, it } from "vitest";

import {
  assertInvitePortfolioCollaboratorInput,
  PORTFOLIO_COLLABORATION_STATES,
  PORTFOLIO_COLLABORATION_VISIBILITIES,
  type CraftsmanProfileId,
  type PortfolioCollaborationId,
  type PortfolioProjectId,
  type UserId,
} from "../src/index.js";

describe("portfolio collaboration", () => {
  it("separates confirmation lifecycle from author visibility", () => {
    expect(PORTFOLIO_COLLABORATION_STATES).toEqual([
      "PENDING",
      "ACCEPTED",
      "DECLINED",
      "AUTHOR_WITHDRAWN",
      "COLLABORATOR_WITHDRAWN",
    ]);
    expect(PORTFOLIO_COLLABORATION_VISIBILITIES).toEqual(["VISIBLE", "HIDDEN"]);
  });

  it("requires a distinct existing-profile identity at the command boundary", () => {
    expect(() =>
      assertInvitePortfolioCollaboratorInput(invite()),
    ).not.toThrow();
    expect(() =>
      assertInvitePortfolioCollaboratorInput({
        ...invite(),
        collaboratorProfileId: invite().authorProfileId,
      }),
    ).toThrow(/collaboratorProfileId/u);
  });

  it.each([
    ["Elektrikár kontakt@example.sk", "Bezpečný príspevok"],
    ["Elektrikár", "Volajte +421 900 123 456"],
    ["Elektrikár", "Adresa: Hlavná 12"],
    ["Elektrikár", "API key: secret-value"],
  ])("rejects unsafe role/contribution text", (role, contribution) => {
    expect(() =>
      assertInvitePortfolioCollaboratorInput({
        ...invite(),
        contribution,
        role,
      }),
    ).toThrow();
  });
});

function invite() {
  return {
    actorUserId: "76000000-0000-4000-8000-000000000001" as UserId,
    authorProfileId:
      "76000000-0000-4000-8000-000000000002" as CraftsmanProfileId,
    collaboratorProfileId:
      "76000000-0000-4000-8000-000000000003" as CraftsmanProfileId,
    collaborationId:
      "76000000-0000-4000-8000-000000000004" as PortfolioCollaborationId,
    commandId: "76000000-0000-4000-8000-000000000005",
    contribution: "Kompletná elektroinštalácia dielne.",
    portfolioProjectId:
      "76000000-0000-4000-8000-000000000006" as PortfolioProjectId,
    role: "Elektrikár",
  };
}
