# UI/UX implementation checkpoint

Updated: 2026-09-29

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
5. **ACTIVE** — authentication/onboarding and craftsman profile, portfolio and credentials.
6. Secondary transactional, account, moderation and admin screens.
7. Responsive/accessibility/visual consistency pass and release checks.

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
