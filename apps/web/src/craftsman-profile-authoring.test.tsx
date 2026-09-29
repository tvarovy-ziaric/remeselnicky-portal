import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CraftsmanProfileWorkspace,
  deriveReadiness,
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
      onAssignProfession={noop}
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
    expect(html).not.toContain("PROF:ELECTRICIAN");
    expect(html).not.toContain("SK0101528595");
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
