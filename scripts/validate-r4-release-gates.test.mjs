import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("R4-031 launch suite is isolated, complete and cannot claim production readiness", async () => {
  const [script, publicRunner, manifest] = await Promise.all([
    source("scripts/run-r4-security-launch-suite.ps1"),
    source("apps/e2e/scripts/run-r4-security-public.ps1"),
    source("docs/testing/r4-security-launch-suite.md"),
  ]);
  for (const required of [
    "--pull never",
    '--tmpfs "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g"',
    '--publish "127.0.0.1::5432"',
    "postgis/postgis:17-3.5-alpine",
    "numPendingTests -ne 0",
    "numTodoTests -ne 0",
    'status = "PASS"',
    'externalProviderEvidence = "NOT_EVALUATED"',
    'realUserLaunchDecision = "NO-GO"',
    "existingStagingTouched = $false",
    "git -C $workspace status --short --untracked-files=all",
    "^portal-r4-031-[0-9a-f]{8}$",
  ]) {
    assert.ok(
      script.includes(required),
      `missing launch-suite guard: ${required}`,
    );
  }
  for (const packageName of [
    "@portal/authorization",
    "@portal/admin-auth",
    "@portal/media",
    "@portal/notifications",
    "@portal/worker",
    "@portal/api",
    "@portal/web",
    "@portal/testing",
    "@portal/db",
  ]) {
    assert.ok(script.includes(`-Package "${packageName}"`));
  }
  assert.doesNotMatch(script, /docker\s+system\s+prune/iu);
  assert.doesNotMatch(script, /--volumes|factory\s+reset|wsl\s+--shutdown/iu);
  for (const required of [
    "r3-competitor-isolation.spec.ts",
    "r3-private-media.spec.ts",
    "r4-quote-acceptance.spec.ts",
    "run-r4-canonical.ps1",
    'realUserLaunchDecision = "NO-GO"',
    "previousFixtureDeleted = $false",
  ]) {
    assert.ok(publicRunner.includes(required));
  }
  assert.doesNotMatch(
    publicRunner,
    /Remove-Item|docker\s+(?:rm|system\s+prune)/iu,
  );
  assert.match(manifest, /LOCAL_ISOLATED_SYNTHETIC/u);
  assert.match(manifest, /PUBLIC_QUICK_TUNNEL_SYNTHETIC/u);
  assert.match(manifest, /zero skipped\/todo tests/u);
  assert.match(manifest, /NO-GO/u);
});

test("R4-032 artifacts keep manual evidence and production go/no-go separate", async () => {
  const [manual, evidence, decision] = await Promise.all([
    source("docs/release/manual-uat.md"),
    source("docs/release/uat-evidence.template.md"),
    source("docs/release/go-no-go-checklist.md"),
  ]);
  assert.match(manual, /MANUAL_SYNTHETIC_UAT/u);
  assert.match(manual, /AUTOMATED_SYNTHETIC/u);
  assert.match(manual, /BLOCKED_HUMAN_GATE/u);
  assert.match(evidence, /MANUAL_SYNTHETIC_UAT/u);
  assert.match(evidence, /AUTOMATED_SYNTHETIC/u);
  assert.match(evidence, /BLOCKED_HUMAN_GATE/u);
  assert.match(decision, /manual UAT/iu);
  assert.match(decision, /AUTOMATED_SYNTHETIC/u);
  assert.match(decision, /BLOCKED_HUMAN_GATE/u);
  assert.match(manual, /registration|registr/u);
  assert.match(manual, /craftsman|remeseln/u);
  assert.match(manual, /refresh|obnov/u);
  assert.match(manual, /multiple tabs|viac.*kar/u);
  assert.match(manual, /interrupted upload|preru.*upload/u);
  assert.match(evidence, /NOT_EVALUATED/u);
  assert.match(evidence, /NO-GO/u);
  assert.match(decision, /NO-GO/u);
  assert.match(decision, /zero.*BLOCKER|0.*BLOCKER/iu);
  assert.match(decision, /zero.*CRITICAL|0.*CRITICAL/iu);
});
