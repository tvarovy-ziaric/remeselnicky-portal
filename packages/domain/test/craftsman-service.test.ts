import { describe, expect, it } from "vitest";

import {
  assertAddCraftsmanServiceInput,
  assertCraftsmanServiceListInput,
  assertDeactivateCraftsmanServiceInput,
  CraftsmanServiceValidationError,
  type AddCraftsmanServiceInput,
  type CraftsmanProfileId,
  type CraftsmanProfessionId,
  type CraftsmanServiceId,
  type UserId,
} from "../src/index.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001" as UserId,
  command: "10000000-0000-4000-8000-000000000002",
  profile: "10000000-0000-4000-8000-000000000003" as CraftsmanProfileId,
  profession: "10000000-0000-4000-8000-000000000004" as CraftsmanProfessionId,
  service: "10000000-0000-4000-8000-000000000005" as CraftsmanServiceId,
  release: "10000000-0000-4000-8000-000000000006",
} as const;

function addCommand(): AddCraftsmanServiceInput {
  return {
    actorUserId: ids.actor,
    commandId: ids.command,
    craftsmanProfileId: ids.profile,
    craftsmanProfessionIds: [ids.profession],
    craftsmanServiceId: ids.service,
    serviceCode: "SERV:VINYL_FLOOR",
    taxonomyReleaseId: ids.release,
  };
}

describe("craftsman managed service commands", () => {
  it("accepts a governed service linked to bounded active profession identities", () => {
    expect(() => assertAddCraftsmanServiceInput(addCommand())).not.toThrow();
    expect(() =>
      assertDeactivateCraftsmanServiceInput({
        actorUserId: ids.actor,
        commandId: ids.command,
        craftsmanProfileId: ids.profile,
        craftsmanServiceId: ids.service,
      }),
    ).not.toThrow();
    expect(() =>
      assertCraftsmanServiceListInput({
        actorUserId: ids.actor,
        craftsmanProfileId: ids.profile,
      }),
    ).not.toThrow();
  });

  it.each([
    { serviceCode: "PROF:FLOOR_LAYER" },
    { serviceCode: "SERV:lowercase" },
    { craftsmanProfessionIds: [] },
    { craftsmanProfessionIds: [ids.profession, ids.profession] },
    { commandId: "browser-command" },
  ])("rejects invalid or replay-ambiguous input %#", (change) => {
    expect(() =>
      assertAddCraftsmanServiceInput({ ...addCommand(), ...change }),
    ).toThrow(CraftsmanServiceValidationError);
  });

  it("does not accept more than eight profession links", () => {
    expect(() =>
      assertAddCraftsmanServiceInput({
        ...addCommand(),
        craftsmanProfessionIds: Array.from(
          { length: 9 },
          (_, index) =>
            `10000000-0000-4000-8000-${(index + 10).toString().padStart(12, "0")}` as CraftsmanProfessionId,
        ),
      }),
    ).toThrow(CraftsmanServiceValidationError);
  });
});
