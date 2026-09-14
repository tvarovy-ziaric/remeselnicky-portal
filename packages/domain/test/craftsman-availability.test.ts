import { describe, expect, it } from "vitest";

import {
  assertAddCraftsmanAvailabilityBlockInput,
  assertArchiveCraftsmanAvailabilityBlockInput,
  assertReplaceCraftsmanAvailabilityBlockInput,
  AVAILABILITY_MAX_BLOCK_DURATION_MS,
  CRAFTSMAN_AVAILABILITY_STATES,
  CraftsmanAvailabilityValidationError,
  type AddCraftsmanAvailabilityBlockInput,
  type CraftsmanAvailabilityBlockId,
  type CraftsmanProfileId,
  type UserId,
} from "../src/index.js";

describe("lightweight craftsman availability", () => {
  it("supports explicit available and unavailable UTC periods", () => {
    expect(CRAFTSMAN_AVAILABILITY_STATES).toEqual([
      "AVAILABLE",
      "BUSY",
      "UNAVAILABLE",
    ]);
    for (const availability of CRAFTSMAN_AVAILABILITY_STATES) {
      expect(() =>
        assertAddCraftsmanAvailabilityBlockInput({
          ...addInput(),
          availability,
        }),
      ).not.toThrow();
    }
  });

  it("allows independent overlapping markings without deriving precedence", () => {
    const first = addInput();
    const second = {
      ...addInput(),
      availability: "UNAVAILABLE" as const,
      blockId:
        "72000000-0000-4000-8000-000000000099" as CraftsmanAvailabilityBlockId,
      startsAt: new Date("2027-01-01T10:00:00.000Z"),
      endsAt: new Date("2027-01-01T11:00:00.000Z"),
    };
    expect(() => assertAddCraftsmanAvailabilityBlockInput(first)).not.toThrow();
    expect(() =>
      assertAddCraftsmanAvailabilityBlockInput(second),
    ).not.toThrow();
    expect(first).not.toHaveProperty("bookingId");
    expect(second).not.toHaveProperty("capacity");
    expect(second).not.toHaveProperty("precedence");
  });

  it("rejects invalid or unbounded intervals", () => {
    const invalid = [
      { startsAt: new Date("invalid") },
      { endsAt: new Date("2027-01-01T08:00:00.000Z") },
      { startsAt: new Date("1999-12-31T23:59:59.999Z") },
      { endsAt: new Date("2200-01-01T00:00:00.001Z") },
      {
        endsAt: new Date(
          addInput().startsAt.valueOf() +
            AVAILABILITY_MAX_BLOCK_DURATION_MS +
            1,
        ),
      },
    ];
    for (const change of invalid) {
      expect(() =>
        assertAddCraftsmanAvailabilityBlockInput({ ...addInput(), ...change }),
      ).toThrow(CraftsmanAvailabilityValidationError);
    }
  });

  it("requires positive CAS revisions for replace and archive", () => {
    expect(() =>
      assertReplaceCraftsmanAvailabilityBlockInput({
        ...addInput(),
        expectedRevision: 0,
      }),
    ).toThrow(CraftsmanAvailabilityValidationError);
    expect(() =>
      assertArchiveCraftsmanAvailabilityBlockInput({
        actorUserId: addInput().actorUserId,
        blockId: addInput().blockId,
        commandId: addInput().commandId,
        craftsmanProfileId: addInput().craftsmanProfileId,
        expectedRevision: 0,
      }),
    ).toThrow(CraftsmanAvailabilityValidationError);
  });
});

function addInput(): AddCraftsmanAvailabilityBlockInput {
  return {
    actorUserId: "72000000-0000-4000-8000-000000000001" as UserId,
    availability: "AVAILABLE",
    blockId:
      "72000000-0000-4000-8000-000000000002" as CraftsmanAvailabilityBlockId,
    commandId: "72000000-0000-4000-8000-000000000003",
    craftsmanProfileId:
      "72000000-0000-4000-8000-000000000004" as CraftsmanProfileId,
    endsAt: new Date("2027-01-01T12:00:00.000Z"),
    startsAt: new Date("2027-01-01T09:00:00.000Z"),
  };
}
