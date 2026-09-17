import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("validates the isolated alpha staging contract", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/validate-alpha-staging.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fail-closed/u);
});
