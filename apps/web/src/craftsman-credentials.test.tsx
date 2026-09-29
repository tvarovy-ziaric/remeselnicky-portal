import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  credentialStatus,
  CredentialStatusPresentation,
  humanizeCode,
} from "./craftsman-credentials";

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

  it("uses a verified trust signal only after approval", () => {
    const pending = renderToStaticMarkup(
      <CredentialStatusPresentation state="PENDING" />,
    );
    expect(pending).toContain("Zatiaľ nie je overený");
    expect(pending).not.toContain("Overené platformou");

    const approved = renderToStaticMarkup(
      <CredentialStatusPresentation state="APPROVED" />,
    );
    expect(approved).toContain("Overené platformou");
    expect(approved).toContain("Overený doklad");
  });

  it("presents governed codes as readable labels", () => {
    expect(humanizeCode("test.required-license")).toBe("Required license");
    expect(humanizeCode("ELECTRICAL_INSPECTION")).toBe("Electrical inspection");
  });
});
