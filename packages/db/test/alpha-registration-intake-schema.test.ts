import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../migrations/0115_alpha_registration_intake.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("0115 invitation-only Alpha registration intake", () => {
  it("starts paused and preserves append-only operational history", () => {
    expect(migration).toContain("'PAUSED'");
    expect(migration).toContain("current_alpha_registration_intake");
    expect(migration).toContain("registration intake history is append-only");
    expect(migration).toContain(
      "alpha_registration_invitation_claims_append_only",
    );
  });

  it("stores only an HMAC email digest in invitation history", () => {
    expect(migration).toContain("email_hmac_digest char(64)");
    expect(migration).not.toMatch(
      /normalized_email|email_address|invite_token/iu,
    );
    expect(migration).toContain("invitation_id uuid PRIMARY KEY");
    expect(migration).toContain("user_id uuid NOT NULL UNIQUE");
  });
});
