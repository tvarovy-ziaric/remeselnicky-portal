import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CraftsmanProfileWorkspace,
  deriveReadiness,
  TaxonomySuggestionDialog,
  taxonomySuggestionDialogKeyAction,
} from "./craftsman-profile-authoring";
import type { CraftsmanAuthoringAggregate } from "./craftsman-profile-authoring-client";

const aggregate = {
  profile: {
    about: "Spoľahlivý elektrikár s praxou.",
    createdAt: "2026-09-28T08:00:00.000Z",
    id: "93000000-0000-4000-8000-000000000001",
    identityVerified: true,
    nickname: "Jano",
    profileType: "INDIVIDUAL",
    realFirstName: "Ján",
    realLastName: "Novák",
    revision: 1,
    updatedAt: "2026-09-28T08:00:00.000Z",
  },
  professions: [
    {
      createdAt: "2026-09-28T08:05:00.000Z",
      deactivatedAt: null,
      declaredLevel: "ADVANCED",
      declaredLevelRevision: 1,
      evidenceSupportedLevel: "MASTER",
      id: "93000000-0000-4000-8000-000000000002",
      professionCode: "PROF:ELECTRICIAN",
      taxonomyLabel: "Elektrikár",
      state: "ACTIVE",
    },
  ],
  publication: {
    approvedAt: "2026-09-28T08:20:00.000Z",
    changedAt: "2026-09-28T08:20:00.000Z",
    effectivelyPublic: false,
    moderationState: "ALLOWED",
    ownerVisibility: "HIDDEN",
    readiness: { isReady: true, missing: [] },
    rejection: null,
    reviewState: "APPROVED",
    revision: 2,
  },
  services: [
    {
      craftsmanProfessionIds: ["93000000-0000-4000-8000-000000000002"],
      createdAt: "2026-09-28T08:06:00.000Z",
      deactivatedAt: null,
      id: "93000000-0000-4000-8000-000000000003",
      serviceCode: "SERV:SOCKET_INSTALLATION",
      taxonomyLabel: "Montáž zásuviek",
      state: "ACTIVE",
    },
  ],
  serviceArea: {
    baseMunicipalityCode: "SK0101528595",
    createdAt: "2026-09-28T08:10:00.000Z",
    extraMunicipalityCodes: [],
    maximumRadiusKm: null,
    normalRadiusKm: 25,
    revision: 1,
    travelFeePolicy: null,
    travelFeeThresholdKm: null,
  },
} satisfies CraftsmanAuthoringAggregate;

const noop = vi.fn(() => Promise.resolve(false));

function renderWorkspace(value: CraftsmanAuthoringAggregate = aggregate) {
  return renderToStaticMarkup(
    <CraftsmanProfileWorkspace
      aggregate={value}
      busy={false}
      message={null}
      onAddService={noop}
      onAssignProfession={noop}
      onDeactivateService={noop}
      onSaveProfile={noop}
      onSaveServiceArea={noop}
      onSubmit={noop}
      onVisibility={noop}
    />,
  );
}

describe("private craftsman profile workspace", () => {
  it("uses shared cards and keeps declared and evidence-supported levels distinct", () => {
    const html = renderWorkspace();

    expect(html).toContain('class="page-header"');
    expect(html).toContain('class="ui-card profile-authoring-card"');
    expect(html).toContain("uvádza remeselník");
    expect(html).toContain("podporené dôkazmi");
    expect(html).toContain("pokročilý");
    expect(html).toContain("majster");
    expect(html).toContain("Profesia alebo služba");
    expect(html).toContain("Odobrať službu");
    expect(html).not.toContain("PROF:ELECTRICIAN");
    expect(html).not.toContain("SK0101528595");
  });

  it("closes the suggestion modal with Escape without treating other keys as close", () => {
    expect(taxonomySuggestionDialogKeyAction("Escape")).toBe("CLOSE");
    expect(taxonomySuggestionDialogKeyAction("Enter")).toBe("NONE");
  });

  it("gives the suggestion name initial focus and exposes a modal boundary", () => {
    const html = renderToStaticMarkup(
      <TaxonomySuggestionDialog
        client={{ load: vi.fn(), submit: vi.fn() }}
        initialName="Chýbajúca služba"
        onClose={vi.fn()}
        onConfirmed={vi.fn()}
        profileId="93000000-0000-4000-8000-000000000001"
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="taxonomy-suggestion-name"');
    expect(html).toContain('autofocus=""');
  });

  it("shows a private requirement checklist without a public completeness percentage", () => {
    const incomplete = {
      ...aggregate,
      profile: {
        ...aggregate.profile,
        about: null,
        identityVerified: false,
      },
      professions: [],
      publication: null,
      serviceArea: null,
      services: [],
    } satisfies CraftsmanAuthoringAggregate;
    expect(deriveReadiness(incomplete)).toHaveLength(5);

    const html = renderWorkspace(incomplete);
    expect(html).toContain("Súkromný kontrolný zoznam");
    expect(html).toContain("dokončite overenie identity účtu");
    expect(html).toContain("doplňte predstavenie svojej práce");
    expect(html).not.toMatch(/\d+\s*%/u);
  });

  it("does not offer an owner visibility override for admin moderation", () => {
    const restricted = {
      ...aggregate,
      publication: {
        ...aggregate.publication,
        moderationState: "RESTRICTED",
      },
    } satisfies CraftsmanAuthoringAggregate;
    const html = renderWorkspace(restricted);

    expect(html).toContain("Skrytý administrátorom");
    expect(html).toContain("Viditeľnosť obmedzil administrátor");
    expect(html).not.toContain("Zverejniť schválený profil");
  });
});
