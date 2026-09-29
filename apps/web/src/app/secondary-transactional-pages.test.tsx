import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import InvitationPage from "./invitations/[invitationId]/page";
import InvitationVersionPage from "./invitations/[invitationId]/verzie/[requestContentRevision]/page";
import InvitationsPage from "./pozvanky/page";
import ParticipantHistoryPage from "./ucasti/historia/page";
import ParticipantHistoryDetailPage from "./ucasti/historia/[participantId]/page";
import ParticipantInvitationsPage from "./ucasti/pozvanky/page";
import ParticipantInvitationPage from "./ucasti/pozvanky/[participantId]/page";
import ParticipantCapabilitiesPage from "./ucasti/schopnosti/[participantId]/page";

const id = "9d400000-0000-4000-8000-000000000011";

function expectAuthenticatedShell(html: string) {
  expect(html).toContain('class="app-shell"');
  expect(html).toContain('class="site-header site-header--authenticated"');
  expect(html).toContain('id="main-content"');
  expect(html).toContain('aria-label="Mobilná navigácia"');
}

describe("secondary transactional route shells", () => {
  it("uses the authenticated shell for invitation and participation inboxes", () => {
    for (const page of [
      <InvitationsPage key="job-invitations" />,
      <ParticipantInvitationsPage key="participant-invitations" />,
      <ParticipantHistoryPage key="history" />,
    ]) {
      expectAuthenticatedShell(renderToStaticMarkup(page));
    }
  });

  it("uses the same private shell for detail, history and capability routes", async () => {
    const pages = [
      await InvitationPage({ params: Promise.resolve({ invitationId: id }) }),
      await InvitationVersionPage({
        params: Promise.resolve({
          invitationId: id,
          requestContentRevision: "2",
        }),
      }),
      await ParticipantInvitationPage({
        params: Promise.resolve({ participantId: id }),
      }),
      await ParticipantHistoryDetailPage({
        params: Promise.resolve({ participantId: id }),
      }),
      await ParticipantCapabilitiesPage({
        params: Promise.resolve({ participantId: id }),
      }),
    ];
    for (const page of pages)
      expectAuthenticatedShell(renderToStaticMarkup(page));
  });
});
