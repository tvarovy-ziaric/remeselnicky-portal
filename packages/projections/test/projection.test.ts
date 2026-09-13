import { describe, expect, it } from "vitest";

import {
  createAdminProjectionView,
  createContextualProjectionView,
  createPrivateProjectionView,
  defineProjectionPlan,
  projectResponse,
  ProjectionError,
  publicProjectionView,
  type ProjectionView,
} from "../src/index.js";

interface ExampleRecord {
  readonly displayName: string;
  readonly email: string;
  readonly exactAddress: string;
  readonly internalNotes: string;
  readonly municipality: string;
  readonly phone: string;
  readonly riskFlags: readonly string[];
  readonly unplannedSecret: string;
}

const source: ExampleRecord = {
  displayName: "Mária",
  email: "private@example.invalid",
  exactAddress: "Private street 12",
  internalNotes: "private admin note",
  municipality: "Žilina",
  phone: "+421900000000",
  riskFlags: ["manual-review"],
  unplannedSecret: "never-project",
};

const plan = defineProjectionPlan<ExampleRecord>({
  displayName: { audience: "PUBLIC", project: (record) => record.displayName },
  email: { audience: "CONFIRMED_CONTACT", project: (record) => record.email },
  exactAddress: {
    audience: "CONFIRMED_ADDRESS",
    project: (record) => record.exactAddress,
  },
  internalNotes: {
    audience: "ADMIN_INTERNAL",
    project: (record) => record.internalNotes,
  },
  municipality: {
    audience: "PUBLIC",
    project: (record) => record.municipality,
  },
  ownerPhone: { audience: "PRIVATE", project: (record) => record.phone },
  phone: { audience: "CONFIRMED_CONTACT", project: (record) => record.phone },
  riskFlags: {
    audience: "ADMIN_INTERNAL",
    project: (record) => record.riskFlags,
  },
});

const permit = { effect: "PERMIT", reason: "POLICY_PERMITTED" } as const;
const deny = { effect: "DENY", reason: "POLICY_DENIED" } as const;

describe("field-level response projections", () => {
  it("returns only explicitly public fields to anonymous/public views", () => {
    expect(projectResponse(plan, source, publicProjectionView)).toEqual({
      displayName: "Mária",
      municipality: "Žilina",
    });
    expect(
      JSON.stringify(projectResponse(plan, source, publicProjectionView)),
    ).not.toMatch(
      /private@example|Private street|421900|admin note|manual-review|never-project/u,
    );
  });

  it("allows private owner data only after an affirmative authorization decision", () => {
    expect(() => createPrivateProjectionView(deny)).toThrow(ProjectionError);
    expect(
      projectResponse(plan, source, createPrivateProjectionView(permit)),
    ).toEqual({
      displayName: "Mária",
      email: "private@example.invalid",
      exactAddress: "Private street 12",
      municipality: "Žilina",
      ownerPhone: "+421900000000",
      phone: "+421900000000",
    });
  });

  it("reveals contact and exact address only through separate contextual grants", () => {
    const invitationView = createContextualProjectionView(permit, []);
    const confirmedContactView = createContextualProjectionView(permit, [
      "CONTACT",
    ]);
    const confirmedJobView = createContextualProjectionView(permit, [
      "CONTACT",
      "EXACT_ADDRESS",
    ]);

    expect(projectResponse(plan, source, invitationView)).not.toHaveProperty(
      "email",
    );
    expect(projectResponse(plan, source, confirmedContactView)).toMatchObject({
      email: "private@example.invalid",
      phone: "+421900000000",
    });
    expect(
      projectResponse(plan, source, confirmedContactView),
    ).not.toHaveProperty("exactAddress");
    expect(projectResponse(plan, source, confirmedJobView)).toHaveProperty(
      "exactAddress",
      "Private street 12",
    );
  });

  it("has no normal-user path for internal notes or risk flags", () => {
    const normalViews = [
      publicProjectionView,
      createPrivateProjectionView(permit),
      createContextualProjectionView(permit, ["CONTACT", "EXACT_ADDRESS"]),
    ];
    for (const view of normalViews) {
      const projected = projectResponse(plan, source, view);
      expect(projected).not.toHaveProperty("internalNotes");
      expect(projected).not.toHaveProperty("riskFlags");
    }

    const adminWithoutInternal = createAdminProjectionView(permit, [
      "SENSITIVE_DATA",
    ]);
    expect(
      projectResponse(plan, source, adminWithoutInternal),
    ).not.toHaveProperty("internalNotes");
    expect(projectResponse(plan, source, adminWithoutInternal)).toMatchObject({
      email: "private@example.invalid",
      exactAddress: "Private street 12",
      phone: "+421900000000",
    });
    const internalAdmin = createAdminProjectionView(permit, ["INTERNAL_NOTES"]);
    expect(projectResponse(plan, source, internalAdmin)).toMatchObject({
      internalNotes: "private admin note",
      riskFlags: ["manual-review"],
    });
  });

  it("rejects unsafe audience declarations for recognizable sensitive fields", () => {
    expect(() =>
      defineProjectionPlan<ExampleRecord>({
        email: { audience: "PUBLIC", project: (record) => record.email },
      }),
    ).toThrow(/cannot be public/u);
    expect(() =>
      defineProjectionPlan<ExampleRecord>({
        riskFlags: {
          audience: "PRIVATE",
          project: (record) => record.riskFlags,
        },
      }),
    ).toThrow(/admin-internal/u);
  });

  it("rejects forged views and hides projection failure details", () => {
    expect(() =>
      projectResponse(plan, source, { kind: "ADMIN" } as ProjectionView),
    ).toThrow(/server-authorized/u);
    const broken = defineProjectionPlan<ExampleRecord>({
      displayName: {
        audience: "PUBLIC",
        project: () => {
          throw new Error("private@example.invalid");
        },
      },
    });
    expect(() => projectResponse(broken, source, publicProjectionView)).toThrow(
      "Response projection failed",
    );
    try {
      projectResponse(broken, source, publicProjectionView);
    } catch (error: unknown) {
      expect(String(error)).not.toContain("private@example.invalid");
    }
  });
});
