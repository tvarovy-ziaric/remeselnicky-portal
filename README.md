# Remeselnícky portál

Invitation-only Web Alpha implemented as a strict TypeScript monorepo. Product rules live in the hash-verified canonical `ROADMAP.md`; execution order lives in `IMPLEMENTATION_BACKLOG.md`.

## Requirements

- Node.js 24 or newer
- pnpm 11 or newer

## Local bootstrap

```bash
./scripts/materialize-canonical-specs.sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run all services in development with `pnpm dev`, or select one workspace with `pnpm --filter <workspace> dev`.

## Workspace layout

- `apps/web` — Next.js web application
- `apps/api` — TypeScript HTTP API
- `apps/worker` — background worker process
- `packages/domain` — framework-independent domain vocabulary
- `packages/contracts` — transport-safe shared API contracts
- `packages/config` — shared configuration boundary
- `packages/testing` — reusable test helpers

Business rules belong in shared server-authoritative packages. The web application must not become the source of domain truth or access the database package directly.
