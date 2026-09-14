# Non-production synthetic seeding

The executable entry point is `pnpm --filter @portal/testing seed:synthetic`.
Operational and safety instructions are in
[`docs/testing/synthetic-seeds.md`](../../docs/testing/synthetic-seeds.md).

Checked-in JSON under `packages/testing/fixtures/` documents the versioned
synthetic location and profession-placeholder formats. It contains no
credentials. The TypeScript validators remain authoritative for execution.
