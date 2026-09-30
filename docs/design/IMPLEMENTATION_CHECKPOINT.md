# UI/UX implementation checkpoint

Updated: 2026-09-30

## Approved visual handoff implementation

Status: **DONE for the supplied handoff and synthetic Quick Alpha**

The hash-verified package under `docs/design/handoff/` is the approved visual
source of truth for this pass. `MANIFEST.sha256` was verified before any asset
or component work. It refines visual composition without changing D01-D30,
authorization, privacy, trust provenance or backend behavior.

### Baseline audit

| Primary screen | Current implementation                                                                                                              | Required correction                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home           | Product-safe copy and journeys exist, but the hero is oversized and uses a CSS-drawn workshop plus a fake lettermark.               | Match the compact split hero and two journey cards, exact locked logo and four-step strip; keep truthful Alpha copy and no invented metrics.                |
| Search         | Governed filters and real result data work, but hierarchy, media ratio, actions and trust treatment differ from the board.          | Apply the compact filter/results composition, locked icons, card hierarchy and evidence-safe trust display.                                                 |
| Public profile | Real public projection and image-first portfolio work, but the hero has no media rail and the information hierarchy is too generic. | Recompose hero, facts, tabs and portfolio around the supplied profile board without exposing new data.                                                      |
| Job cockpit    | All domain actions exist, but the tracker is vertical and the overview is a long single column.                                     | Add the four-stage horizontal tracker and a three-column overview with the state-aware next action first; preserve every command guard and history section. |

### Asset and content boundaries

- Copy only the locked SVG logo and icons from the handoff into the web public
  asset directory.
- Reference-board photographs and crops remain reference-only and are never
  shipped. There is currently no approved production workshop photograph in the
  repository, so the hero must keep a neutral visual treatment until such an
  asset is supplied; it must not fabricate a photo or reuse the board crop.
- Inter and Source Serif 4 are loaded through Next.js' self-hosting font
  mechanism. No browser request is made to Google at runtime.
- Screenshots and comparison artifacts stay under ignored local artifact paths
  and must not contain secrets or production data.

### Verification still required before DONE

- focused component tests plus web TypeScript, ESLint and production build;
- desktop 1440x900 and mobile 390x844 screenshots for home, search, profile and
  job cockpit;
- at least one visual correction pass per primary screen;
- Quick Alpha browser smoke through the existing session gate, using synthetic
  fixtures only.

### Completion evidence

- The locked logo and thirteen handoff SVG icons were copied byte-for-byte and
  their SHA-256 digests match the supplied assets. Reference photography was
  not shipped.
- The home, search, public profile and Job cockpit compositions are implemented
  with Inter/Source Serif 4, the approved tokens and preserved product truth.
- Web verification passed: 83 test files / 413 tests, TypeScript, ESLint and an
  optimized Next.js production build.
- The worktree release was deployed to the healthy synthetic Quick Alpha. A
  headless Chromium pass captured 1440x900 and 390x844 viewport screenshots for
  all four primary screens and verified the public and authenticated routes.
- The mandatory correction pass fixed inherited profile width/padding,
  tightened the desktop home hero so both journey cards enter the first view,
  and made the four-stage mobile Job tracker legible. The repeated browser
  smoke passed after redeployment.
- The only intentional fidelity gap is photographic: every supplied raster is
  explicitly reference-only and no approved production workshop photograph
  exists. The production hero therefore uses the exact brand mark and approved
  palette in a neutral workshop treatment rather than misusing a reference crop
  or importing an unapproved image.

## Source of truth and boundaries

The permanent design sources are `DESIGN_CULTURE.md`, `UX_GUIDELINES.md` and
`design-tokens.json` in this directory. The PNG boards are directional visual
references. Locked D01-D30 product rules, authorization, privacy, state-machine
invariants and real backend capabilities remain authoritative.

The redesign must not invent ratings, counters, provider claims, ranking reasons
or product capabilities. Trust signals must keep their provenance visible:
self-declared, supported by evidence, platform-verified and customer review are
different facts.

## Audit summary

- The product flows and server-side boundaries are already broad, but the web UI
  is assembled from page-specific styles and lacks a shared application shell.
- The home page currently exposes implementation terminology and internal links
  instead of explaining the two primary user journeys.
- Search and public profiles use real API data and generally preserve trust
  provenance, but their visual hierarchy, empty states and responsive layout are
  inconsistent.
- The request flow already preserves drafts and authentication return context;
  its review and choice labels still need a consistent human-language layer.
- Jobs, quotes and account/admin screens contain the required domain actions but
  frequently present them as dense forms or lists without a clear next action.
- Broad global `main` and `section` CSS rules make incremental composition risky;
  new layout primitives must be scoped and older routes migrated in layers.

## Delivery layers

1. **DONE** — tokens, shared primitives, public shell/navigation and home page.
2. **DONE** — search results and public craftsman profile.
3. **DONE** — request wizard and authentication hand-off.
4. **DONE** — dashboard, quote comparison and central job cockpit.
5. **DONE** — authentication/onboarding and craftsman profile, portfolio and credentials.
6. **DONE** — secondary transactional, account, moderation and admin screens.
7. **DONE** — responsive/accessibility/visual consistency pass and release checks.

Each layer is complete only after focused component tests plus web typecheck,
lint and build pass. Repository-wide checks remain the final gate.

## Core component target

The shared vocabulary is: `AppShell`, public/authenticated headers, mobile bottom
navigation, `PageHeader`, buttons, form controls, cards, status/trust badges,
empty states, notices, tabs, stepper, timeline, next-action card, search-result
card, profile hero, section header and confirmation dialog. Components are added
when a real route consumes them; placeholder capability is not shipped.

## Current acceptance checkpoint

- Canonical design files live directly under `docs/design/` and are referenced
  by root `AGENTS.md`.
- Token values are represented as CSS custom properties and shared primitives do
  not depend on mock data.
- Public navigation contains only Remeselníci, Ako to funguje, Vytvoriť dopyt and
  Prihlásiť sa.
- Home page clearly separates the customer and invited-craftsman journeys, has a
  truthful process explanation and exposes no internal API/version terminology.
- Keyboard focus, semantic landmarks, reduced-motion behavior and mobile layouts
  are verified before this layer is marked complete.

## Completed layer 1 evidence

- Canonical tokens are available as CSS custom properties; the initial shared
  primitives, public/authenticated navigation variants and mobile navigation are
  implemented without changing server-side behavior.
- The public home page presents the two truthful journeys, the five-step customer
  flow and a textual trust-provenance legend. It contains no demo metrics or
  internal API terminology.
- Focus styles, a skip link, reduced-motion handling and responsive layouts are
  included. Desktop and narrow renders were visually inspected from the local
  production-capable build.
- Web verification passed: 70 test files / 358 tests, TypeScript, ESLint and the
  optimized Next.js build.

Layer 2 will reuse the safe existing public projections. It will not broaden the
public DTOs or infer verification: profile portfolio remains self-declared unless
the backend explicitly supplies a stronger provenance.

## Completed layers 2-3 evidence

- Search now has an optional governed municipality selector, explicit profile
  actions, provenance-aware cards and cursor pagination that preserves only
  allowlisted filters and an unambiguous request/job context.
- Search DTO parsing rejects unknown badge/reason kinds and incoherent rating
  aggregates. Missing facts stay absent; profile images remain neutrally labelled.
- Public profiles use a real hero, section navigation and image-first portfolio.
  Portfolio is always marked self-declared, public contact data stays absent and
  unknown internal codes fall back to neutral human text.
- The request wizard keeps the existing six-step server-draft flow. Going back
  waits for confirmation of the exact current payload; autosave reports only
  confirmed persistence and review rows no longer expose managed codes/enums.
- Integrated web verification passed: 73 test files / 372 tests, TypeScript,
  ESLint, formatting, import boundaries and the optimized Next.js build.

## Completed layer 4 evidence

- The authenticated job list now exposes truthful human status labels, a safe
  counterpart summary, a clear next action and an honest empty state without
  inventing customer identity or operational facts.
- Quote comparison keeps immutable revisions, scope, terms, validity and real
  trust provenance visible. It does not manufacture a recommended winner and
  exposes an acceptance action only when the backend marks it eligible.
- The central job cockpit combines the lifecycle tracker, one state-aware next
  action, messages, progress, documents, participants and changes without
  weakening existing command guards, idempotency or server authorization.
- Authenticated navigation now has a real conversations entry that directs users
  back to job context instead of advertising a nonexistent global inbox.
- Integrated web verification passed: 76 test files / 381 tests, TypeScript,
  ESLint, formatting, import boundaries and the optimized Next.js build.

## Completed layer 5 evidence

- Authentication and onboarding now share the public application shell, explain
  the invitation-only boundary and preserve the existing draft return target.
  E-mail and phone verification expose a readable two-step journey without
  changing one-time-token, OTP or server authorization rules.
- The private craftsman profile has a clear publication state, private readiness
  checklist and separate self-declared versus evidence-supported profession
  levels. Initial publication remains subject to administrator approval and a
  moderation override cannot be bypassed by the profile owner.
- Portfolio authoring is image-first, keeps the fifteen-photo limit visible and
  labels every self-created project as declared by the craftsman. Consent and
  EXIF/GPS privacy handling are explained without claiming a stronger provenance.
- Credential evidence remains private. Only an approved credential is presented
  as platform-verified; pending, rejected and revoked states stay distinct.
- Integrated web verification passed: 79 test files / 391 tests, TypeScript,
  ESLint, formatting and the optimized Next.js build.

## Completed layer 6 evidence

- Notification and privacy centers now use the shared authenticated shell,
  human-readable state labels and clear workflow boundaries. Reading a
  notification is not presented as a business approval, critical delivery
  cannot be silently disabled and account closure is not described as a
  destructive cascade delete.
- Invitation and participation inboxes, details, history and capability flows
  now expose context, provenance and a neutral next action while preserving
  competition privacy, command idempotency and server-side state guards.
- Deep private routes for conversations, quote acceptance, Job milestones,
  progress, issues, participants, evaluations and Change-order revisions share
  the authenticated application shell and retain non-indexable metadata.
- Admin screens prioritize capability-gated operational queues over vanity
  analytics. Moderation reports remain signals rather than verdicts; sensitive
  actions preserve explicit reason, audit and history boundaries.
- Integrated web verification passed: 82 test files / 403 tests, TypeScript and
  ESLint. The optimized build is repeated in the final layer together with the
  repository-wide release checks.

## Completed layer 7 evidence

- Every private route now exposes a consistent main landmark and application
  shell; active desktop/mobile navigation is marked semantically. Duplicate
  notification utilities were removed and private routes remain non-indexable.
- Focus, reduced-motion, readable status/provenance text, empty/error/loading
  states and narrow-layout rules are part of the shared system rather than
  isolated page fixes.
- Desktop and exact 390 px mobile renders were inspected for the home, public
  search, sign-in and invitation-only registration journeys. The full home page
  preserves hierarchy and action clarity without horizontal overflow.
- The complete repository `pnpm check` passed: formatting, TypeScript for all 24
  packages, ESLint/import boundaries, unit/integration/security/recovery/release
  checks and every production build. Web results remain 82 test files / 403
  tests; repository E2E scenarios that require the explicit external runtime
  gate remained skipped by their existing configuration.
