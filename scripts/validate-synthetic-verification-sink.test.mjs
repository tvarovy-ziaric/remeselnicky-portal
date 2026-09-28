import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readRepositoryFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  compose,
  nginx,
  gitignore,
  dockerignore,
  sink,
  serverConfig,
  syntheticVerification,
  start,
  decision,
] = await Promise.all([
  readRepositoryFile("compose.alpha.yaml"),
  readRepositoryFile("infra/alpha/nginx.conf.template"),
  readRepositoryFile(".gitignore"),
  readRepositoryFile(".dockerignore"),
  readRepositoryFile("infra/alpha/synthetic-verification-sink.mjs"),
  readRepositoryFile("packages/config/src/server.ts"),
  readRepositoryFile("apps/api/src/auth/synthetic-verification.ts"),
  readRepositoryFile("apps/api/src/start.ts"),
  readRepositoryFile("docs/adr/0027-synthetic-verification-sink.md"),
]);

function serviceBlock(name) {
  const match = new RegExp(
    `^  ${name}:[\\s\\S]*?(?=^  [a-zA-Z0-9_-]+:|^volumes:|^secrets:|^networks:)`,
    "mu",
  ).exec(compose);
  assert.ok(match, `Missing Compose service ${name}`);
  return match[0];
}

test("keeps the synthetic verification sink off every public edge", () => {
  const sinkService = serviceBlock("synthetic-verification-sink");

  assert.match(sinkService, /alpha-internal/u);
  assert.doesNotMatch(sinkService, /alpha-edge/u);
  assert.match(
    sinkService,
    /127\.0\.0\.1:\$\{ALPHA_SYNTHETIC_VERIFICATION_PORT:-8467\}:8467/u,
  );
  assert.doesNotMatch(
    sinkService,
    /(?:0\.0\.0\.0|\[::\]):\$\{ALPHA_SYNTHETIC_VERIFICATION_PORT/u,
  );
  assert.doesNotMatch(nginx, /synthetic-verification-sink|8467/iu);
});

test("separates fixture gates and sink capabilities", () => {
  const api = serviceBlock("api");
  const sinkService = serviceBlock("synthetic-verification-sink");

  assert.match(api, /ALPHA_SYNTHETIC_FIXTURE:\s*["']?1["']?/u);
  assert.match(api, /SYNTHETIC_VERIFICATION_MODE:\s*encrypted-sink/u);
  assert.match(
    api,
    /SYNTHETIC_VERIFICATION_SINK_ORIGIN:\s*http:\/\/synthetic-verification-sink:8467/u,
  );
  assert.match(
    api,
    /SYNTHETIC_VERIFICATION_INGEST_KEY_FILE:\s*\/run\/secrets\/synthetic_verification_ingest_key/u,
  );
  assert.match(
    api,
    /SYNTHETIC_REGISTRATION_SIGNING_KEY_FILE:\s*\/run\/secrets\/synthetic_registration_signing_key/u,
  );
  assert.doesNotMatch(api, /synthetic_verification_claim_key/u);
  assert.doesNotMatch(api, /synthetic_verification_encryption_key/u);

  assert.match(sinkService, /synthetic_verification_ingest_key/u);
  assert.match(sinkService, /synthetic_verification_claim_key/u);
  assert.match(sinkService, /synthetic_verification_encryption_key/u);
  assert.doesNotMatch(sinkService, /synthetic_registration_signing_key/u);
});

test("mounts sink credentials only from ignored secret files", () => {
  for (const name of [
    "synthetic_verification_ingest_key",
    "synthetic_verification_claim_key",
    "synthetic_verification_encryption_key",
    "synthetic_registration_signing_key",
  ]) {
    assert.match(
      compose,
      new RegExp(
        `${name}:[\\s\\S]*?file: \\.\\/\\.alpha\\/secrets\\/${name}`,
        "u",
      ),
    );
  }

  assert.match(gitignore, /^\.alpha\/$/mu);
  assert.match(dockerignore, /^\.alpha$/mu);
  assert.doesNotMatch(
    compose,
    /SYNTHETIC_(?:VERIFICATION|REGISTRATION)_(?:INGEST|CLAIM|ENCRYPTION|SIGNING)_KEY:\s*[^\s$]/u,
  );
});

test("keeps delivery bounded, encrypted and one-time", () => {
  assert.match(sink, /node:sqlite/u);
  assert.match(sink, /aes-256-gcm/iu);
  assert.match(sink, /createCipheriv/u);
  assert.match(sink, /createDecipheriv/u);
  assert.match(sink, /createHmac/u);
  assert.match(sink, /\/v1\/deliver/u);
  assert.match(sink, /\/v1\/claim/u);
  assert.match(sink, /\/health\/ready/u);
  assert.match(sink, /["']cache-control["']\s*[:,]\s*["']no-store/iu);
  assert.match(sink, /DELETE FROM/iu);
  assert.match(sink, /expires/iu);
  assert.match(sink, /capacity|maximum|MAX_/iu);
  assert.doesNotMatch(sink, /\/v1\/(?:list|messages|mailbox|deliveries)/iu);
});

test("rejects production and non-synthetic recipients by construction", () => {
  const runtime = `${serverConfig}\n${syntheticVerification}\n${start}`;

  for (const name of [
    "ALPHA_SYNTHETIC_FIXTURE",
    "SYNTHETIC_VERIFICATION_MODE",
    "SYNTHETIC_VERIFICATION_SINK_ORIGIN",
    "SYNTHETIC_VERIFICATION_INGEST_KEY",
    "SYNTHETIC_REGISTRATION_SIGNING_KEY",
  ]) {
    assert.match(runtime, new RegExp(name, "u"));
  }
  assert.match(runtime, /production/iu);
  assert.ok(syntheticVerification.includes("synthetic\\.e2e\\."));
  assert.ok(syntheticVerification.includes("portal\\.invalid"));
  assert.ok(syntheticVerification.includes("\\+999"));
  assert.match(syntheticVerification, /createHmac/u);
  assert.match(runtime, /encrypted-sink/u);
});

test("documents the non-production threat boundary and provider gate", () => {
  assert.match(decision, /zero-cost, test-only/iu);
  assert.match(decision, /HUMAN GATE/u);
  assert.match(decision, /must never be widened/iu);
  assert.match(decision, /production fallback/iu);
  assert.match(decision, /never URLs/iu);
  assert.match(decision, /screenshots, Playwright traces, videos/iu);
});
