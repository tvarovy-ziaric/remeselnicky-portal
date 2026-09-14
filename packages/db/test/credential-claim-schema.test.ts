import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  credentialClaimCommands,
  credentialClaimDecisions,
  credentialClaimEvidence,
  credentialClaimRevisions,
  credentialClaims,
  credentialTypePolicies,
} from "../src/schema/credential-claim.js";

const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0023_credential_claim_review.sql", import.meta.url),
  ),
  "utf8",
);

describe("credential claim schema", () => {
  it("exports explicit claims, evidence, decisions and immutable revisions", () => {
    expect(credentialTypePolicies.evidenceRequirement).toBeDefined();
    expect(credentialClaims.craftsmanProfessionId).toBeDefined();
    expect(credentialClaimEvidence.mediaAssetId).toBeDefined();
    expect(credentialClaimDecisions.toState).toBeDefined();
    expect(credentialClaimCommands.actorPrivilegedSessionHash).toBeDefined();
    expect(credentialClaimRevisions.evidenceCount).toBeDefined();
  });

  it("uses locked states and server-owned type evidence policy", () => {
    expect(migration).toMatch(
      /'PENDING',[\s\S]*'APPROVED',[\s\S]*'REJECTED',[\s\S]*'REVOKED'/u,
    );
    expect(migration).toMatch(/credential_type_policies/u);
    expect(migration).toMatch(/server-installed and immutable/u);
    expect(migration).not.toMatch(/INSERT INTO credential_type_policies/u);
  });

  it("requires current READY private evidence before approval", () => {
    expect(migration).toMatch(
      /OLD\.evidence_requirement = 'REQUIRED'[\s\S]*asset\.status::text = 'READY'/u,
    );
    expect(migration).toMatch(/object\.storage_area::text = 'private'/u);
    expect(migration).toMatch(/object\.revoked_at IS NULL/u);
    expect(migration).toMatch(
      /asset\.provenance_entity_type::text = 'CREDENTIAL'/u,
    );
  });

  it("linearizes evidence attachment against canonical-object revocation", () => {
    expect(migration).toMatch(
      /SELECT \* INTO asset_record[\s\S]*WHERE asset\.id = NEW\.media_asset_id[\s\S]*FOR UPDATE;/u,
    );
    expect(migration).toMatch(
      /SELECT \* INTO canonical_object[\s\S]*object\.revoked_at IS NULL[\s\S]*FOR UPDATE;/u,
    );
    expect(migration).toMatch(/canonical_object\.id IS NULL/u);
  });

  it("locks the complete MFA authorization chain", () => {
    expect(migration).toMatch(
      /FOR UPDATE OF privileged, base, actor, factor, role/u,
    );
    expect(migration).toMatch(/admin\.credentials\.review/u);
    expect(migration).toMatch(
      /credential review command requires matching decision and audit effects/u,
    );
  });

  it("preserves append-only command, evidence, decision and revision history", () => {
    expect(migration).toMatch(
      /credential claim command history is append-only/u,
    );
    expect(migration).toMatch(/credential evidence history is append-only/u);
    expect(migration).toMatch(/credential decisions are append-only/u);
    expect(migration).toMatch(
      /credential claim revision history is append-only/u,
    );
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/u);
  });

  it("adds a distinct image purpose without using its enum literal directly", () => {
    expect(migration).toMatch(/ADD VALUE IF NOT EXISTS 'CREDENTIAL_IMAGE'/u);
    expect(migration).toMatch(/purpose::text = 'CREDENTIAL_IMAGE'/u);
    expect(migration).not.toMatch(/purpose = 'CREDENTIAL_IMAGE'/u);
  });
});
