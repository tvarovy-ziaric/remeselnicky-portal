# ADR 0001: TypeScript monorepo tooling

- Status: Accepted
- Date: 2026-09-13
- Backlog: R0-001
- Locked references: D26, D30

## Context

The Web Alpha needs separately deployable web, API, and worker processes while keeping domain vocabulary and transport contracts authoritative and reusable by a later mobile client. Installation and all quality gates must be reproducible and runnable from the repository root.

## Decision

Use a pnpm workspace coordinated by Turborepo. All production code uses strict TypeScript and ESM package boundaries.

- `apps/web` uses Next.js and React.
- `apps/api` owns the HTTP boundary.
- `apps/worker` is an independently runnable background process.
- framework-independent code lives under `packages/*`.
- domain and API contracts may be imported by apps; browser-facing code may not import the database package.
- root build, typecheck, lint, and test commands execute the corresponding workspace tasks.

The lockfile is committed and CI will use frozen installation. Runtime configuration, database access, authentication, and product state machines are deliberately deferred to their dedicated R0 tickets.

## Consequences

The deployable processes can evolve independently without duplicating business rules. Shared-package builds become explicit dependencies of consuming apps. Workspace boundaries add a small amount of configuration but make later API/mobile reuse and CI checks deterministic.
