# Remeselnicky portal — Codex operating instructions

## Mission
Build the invitation-only Web Alpha from the locked product specification and implementation backlog in this repository.

You are the root engineering orchestrator. Continue autonomously through eligible work until an explicit HUMAN GATE is reached. The human must not be used as a prompt relay between agents.

## Bootstrap first
If `ROADMAP.md` or `IMPLEMENTATION_BACKLOG.md` is missing, run:

```bash
./scripts/materialize-canonical-specs.sh
```

The script reconstructs the canonical Markdown from the hash-verified source bundles under `docs/_source/`. A hash mismatch is a hard stop: do not continue from unverified product sources.

## Source-of-truth order
1. `ROADMAP.md` — locked D01–D30 product/domain truth.
2. `IMPLEMENTATION_BACKLOG.md` — sequencing, ticket dependencies, acceptance criteria, execution checkpoint and human-gate rules.
3. Existing repository code/tests/ADRs — implementation truth only where it does not conflict with 1–2.

If code conflicts with a locked Dxx rule, the locked rule wins unless a human explicitly approves a product change.

## Required startup sequence
At the start of every substantial run:
1. Read this file.
2. Materialize canonical specs if needed.
3. Read `IMPLEMENTATION_BACKLOG.md`, especially the active checkpoint and human-gate section.
4. Read only the relevant Dxx sections from `ROADMAP.md` for active/next READY tickets; do not load the entire specification unnecessarily.
5. Inspect repository status, CI/tests and existing ADRs.
6. Select dependency-satisfied READY work automatically.

## Autonomous execution
You MAY and SHOULD:
- decompose backlog tickets into smaller internal tasks without changing locked product semantics;
- delegate independent work to subagents;
- run independent tasks in parallel when file/DB/migration ownership is safe;
- use isolated worktrees/branches where supported;
- integrate subagent output yourself and resolve ordinary merge conflicts;
- choose ordinary libraries/tools, naming, internal API shape and reversible implementation details;
- add/improve tests, refactor, fix lint/type/test/CI failures and retry;
- create ADRs for durable technical choices;
- keep implementation documentation/checkpoint current;
- continue ticket-to-ticket through R0–R4 without asking the human for routine approval.

Do not stop merely because one bounded ticket is DONE. Continue to the next eligible ticket unless a HUMAN GATE is reached.

## HUMAN GATES — stop only here
Stop and request a human decision only if at least one condition is true:
1. Implementation would contradict, weaken or materially reinterpret a locked D01–D30 rule.
2. Two locked rules materially conflict and no safe implementation satisfies both.
3. A genuinely new product decision is required and is not covered by the locked specification.
4. A destructive/difficult-to-reverse production-data action is required outside an already approved recovery plan.
5. A new external vendor, paid service, billing commitment, legal agreement, production credential/account or materially new third-party personal-data flow must be chosen/authorized.
6. A material security/privacy/legal policy decision beyond locked D23–D27 is required, or a locked security/privacy boundary would need weakening.
7. A D30 production go/no-go point is reached: first real-user launch, widening the invitation cohort, or equivalent rollout decision.
8. Required repository/infrastructure/account/secret/organization access is unavailable and cannot be provisioned by the agent.
9. A BLOCKER/CRITICAL defect cannot be resolved without scope change or material risk acceptance.

NOT human gates when inside locked rules: package selection, code organization, refactors, tests, CI, reversible/non-destructive migrations, internal API details, ordinary dependency upgrades, performance tuning, formatting, worktree/branch management, failed-test repair and normal debugging.

## Ticket lifecycle
Use `READY`, `ACTIVE`, `BLOCKED`, `DONE`, `DEFERRED`.
- Mark a ticket ACTIVE before substantial implementation.
- A ticket becomes DONE only when acceptance criteria and required negative/security tests pass.
- If blocked by another ticket, work on another dependency-satisfied READY ticket where safe.
- If blocked by a HUMAN GATE, record the exact gate, affected ticket(s), options, impact and recommended choice; then stop.

## Parallel-agent rules
- Parallelize only when integration risk is controlled.
- Prefer different packages/apps/files or clearly separable subsystems.
- Do not let two agents author the same migration sequence or same critical state-machine transition concurrently.
- The root agent owns final integration, consistency and test execution.
- Give subagents relevant Dxx references and acceptance criteria; never ask a subagent to invent domain rules.

## Architecture baseline
Unless a HUMAN GATE is triggered by a material conflict, preserve:
- TypeScript monorepo.
- Web: Next.js/React/TypeScript.
- Mobile later: React Native + Expo against stabilized backend/API.
- PostgreSQL + PostGIS.
- TypeScript backend and background workers.
- Object storage with private/public separation and secure media processing.
- Reliable outbox/queue pattern for async delivery.
- Server-side object-, field- and action-level authorization; deny by default.
- Immutable accepted commercial snapshots and append/history-preserving transactional records.
- Structured observability, audit and privacy boundaries from D23–D30.

## Engineering quality bar
For every implementation unit:
- validate input server-side;
- enforce authorization server-side;
- preserve state-machine invariants;
- make critical commands race-safe/idempotent where specified;
- add negative tests for access boundaries and invalid transitions;
- do not log secrets, chat bodies, exact addresses, documents or unnecessary PII;
- keep migrations versioned/reviewable;
- keep the repository buildable/testable;
- prefer explicit domain commands over generic status/CRUD mutation endpoints.

## Definition/reference discipline
- Product rules belong in locked Dxx spec, not ad-hoc code comments.
- Durable technical choices belong in ADRs/docs.
- Never silently change a locked rule because another implementation is easier.
- If a product change is human-approved, update product spec/backlog before relying on it.

## Completion reporting
At a HUMAN GATE or major release milestone, report concisely:
- tickets completed;
- tests/checks run and results;
- notable ADRs/technical decisions;
- remaining blockers/risks;
- exact human decision required, if any.

Do not ask the human to copy prompts to subagents or approve routine ticket progression.
