import { describe, expect, it } from "vitest";

import { credentialStatus } from "./craftsman-credentials";

describe("credential owner copy", () => {
  it("never presents an unreviewed or rejected claim as verified", () => {
    expect(credentialStatus({ state: "PENDING" })).toEqual({
      title: "Čaká na kontrolu.",
      description:
        "Doklad čaká na kontrolu administrátorom. Zatiaľ nie je overený.",
    });
    expect(credentialStatus({ state: "REJECTED" }).description).toContain(
      "Nie je overený",
    );
    expect(credentialStatus({ state: "REVOKED" }).description).toContain(
      "nie je overený",
    );
    expect(credentialStatus({ state: "APPROVED" }).title).toBe(
      "Overený doklad.",
    );
  });
});
