# CODEX EXECUTION PROMPT — Remeselnícky portál design implementation

You are working in the existing **Remeselnícky portál** repository.

Your task is to implement the approved ChatGPT design contained in this handoff package.

## Core instruction

# DO NOT REDESIGN. IMPLEMENT.

The supplied visual design is the **SOURCE OF TRUTH**.

Your job is to:

- analyze the supplied references,
- implement them in the existing application,
- preserve existing product/domain/security behavior,
- use the supplied assets and design tokens,
- implement responsive behavior conservatively,
- run the application in a real browser,
- capture screenshots,
- compare them to the supplied references,
- correct visual differences,
- repeat until visual fidelity is high.

Your job is **not** to modernize, reinterpret, simplify, restyle or improve the design according to your own taste.

---

## 1. Read these files first

Treat the directory containing this `CODEX_PROMPT.md` as `HANDOFF_ROOT`.

Read, in order:

1. repository root `AGENTS.md`
2. relevant locked product/domain specification and current execution checkpoint
3. `HANDOFF_ROOT/README.md`
4. `HANDOFF_ROOT/reference/REFERENCE_NOTES.md`
5. `HANDOFF_ROOT/DESIGN_SYSTEM.md`
6. `HANDOFF_ROOT/design/tokens.css`
7. `HANDOFF_ROOT/design/design-manifest.json`
8. `HANDOFF_ROOT/design/component-specs.md`
9. `HANDOFF_ROOT/ASSET_MANIFEST.md`
10. `HANDOFF_ROOT/design/visual-comparison.md`
11. `HANDOFF_ROOT/ACCEPTANCE_CRITERIA.md`

Then inspect the approved images:

- `HANDOFF_ROOT/reference/reference-desktop-board.png`
- `HANDOFF_ROOT/reference/reference-design-system.png`
- `HANDOFF_ROOT/reference/reference-homepage-above-fold.png`
- `HANDOFF_ROOT/reference/reference-search-above-fold.png`
- `HANDOFF_ROOT/reference/reference-profile-above-fold.png`
- `HANDOFF_ROOT/reference/reference-job-above-fold.png`

Do not start visual implementation before reviewing these files.

---

## 2. Existing project constraints

This is not a greenfield project.

The project already has a working architecture and locked product definition. Preserve it.

Current architecture baseline includes:

- Next.js
- React
- TypeScript
- TypeScript monorepo
- Node.js API/worker
- PostgreSQL/PostGIS
- object storage/media pipeline
- existing automated browser/integration/security tests

The redesign is primarily a **web UI implementation task**.

Do not replace the stack with another frontend framework, CSS framework or application architecture merely to reproduce the design.

Do not alter locked D01–D30 semantics, security, privacy, authorization, idempotency, audit or state-machine behavior for visual convenience.

Do not create a new paid provider, vendor account, billing relationship, production credential, production deployment or real-user rollout. Those remain HUMAN GATES according to the repository instructions.

Current temporary testing can continue through the existing local notebook + Docker + Quick Tunnel workflow.

---

## 3. Visual source-of-truth hierarchy

The authoritative visual order is:

1. `reference/reference-desktop-board.png`
2. `reference/reference-design-system.png`
3. page-specific reference crops
4. `design/tokens.css`
5. `design/component-specs.md`

The images are not inspiration. They are the design target.

The generated board contains presentation annotations around the actual UI. Read `reference/REFERENCE_NOTES.md` and do not implement those annotations into the application.

If prose in this handoff conflicts with an unmistakable visible property of the approved UI reference, prefer the visual reference unless doing so would violate locked product/security/privacy behavior.

---

# 4. ASSET LOCK

## ASSETS ARE AUTHORITATIVE.

The files under `HANDOFF_ROOT/assets/` are locked implementation/reference assets.

If an asset exists for a purpose, use that exact file.

You MUST NOT:

- redraw the logo,
- substitute the logo with another tool/house/hammer graphic,
- replace supplied icons with letters,
- replace supplied icons with emoji,
- replace supplied icons with Unicode symbols,
- use Unicode `★`, `♥`, `✓`, etc. where a supplied asset exists,
- replace supplied icons with Lucide,
- replace supplied icons with Heroicons,
- replace supplied icons with FontAwesome,
- alter asset proportions,
- recolor locked brand assets,
- recreate a supplied asset from the screenshot.

Use `ASSET_MANIFEST.md` to understand the role of every asset.

The logo symbol `assets/logo-symbol.svg` is a documented technical vector reconstruction from the approved raster design because the original vector source does not exist. For this handoff it is authoritative.

Reference/content imagery such as portrait/portfolio crops is not product data. Do not hard-code those people or factual claims into production. They may be used in test-only visual fixtures where appropriate.

---

# 5. COLOR LOCK

Use colors only from `design/tokens.css`, except for unavoidable browser/system rendering details.

You MUST NOT arbitrarily:

- add new brand colors,
- increase saturation,
- increase contrast because you think the design looks too muted,
- make the terracotta brighter,
- make the green brighter,
- add SaaS blue/purple gradients,
- convert the warm neutral canvas into cool gray,
- use pure black for normal typography,
- use pure white as the page canvas,
- add colored shadows or glows.

Important locked colors include:

- background: `#F7F5F0`
- surface: `#FFFFFF`
- primary text: `#202523`
- secondary text: `#5E6864`
- primary green: `#285C4D`
- terracotta accent: `#C66A42`
- trust blue: `#356F8A`
- soft border: `#D8D3C8`

Semantic extensions must first reuse existing tokens. If a genuinely distinct product state requires a new color, document the need before adding it; do not silently introduce one.

---

# 6. TYPOGRAPHY LOCK

Operational UI uses **Inter**.

Display/brand/marketing headings use **Source Serif 4** as the documented technical approximation of the serif face visible in the approved raster reference.

Do not bundle or expose font files in the repository as part of this handoff. Use the project's normal framework/web-font mechanism.

You MUST NOT arbitrarily:

- replace the font family,
- replace the serif display treatment with a sans font,
- increase or reduce headings according to personal taste,
- change weight,
- change line-height,
- change letter-spacing,
- convert all typography to a default design-system scale.

Use the exact token values in `design/tokens.css`.

Responsive typography may use only the documented responsive token adjustments unless a real overflow bug requires a minimal deviation.

If a deviation is unavoidable, document it and keep it as small as possible.

---

# 7. GEOMETRY LOCK

The approved design is superior to generic framework spacing conventions.

Do not normalize geometry to 8/16/24/32px simply because it is conventional.

The handoff intentionally includes values such as:

- 18px,
- 21px,
- 28px,
- 44px,
- 50px,
- 52px.

Use the component geometry in `design/component-specs.md`.

Core geometry includes:

- page max width around `1200px`,
- desktop page padding `24px`,
- header height `72px`,
- controls `44px`,
- large CTA `50px`,
- standard card radius `12px`,
- feature/hero radius `18–21px`,
- warm white cards with subtle borders and mild shadows.

Do not make everything more rounded, more spacious, flatter or denser because you prefer a different visual system.

---

## 8. Product mental model that the design must communicate

The backend contains many precise domain entities and state machines. The UI must not mechanically expose that complexity.

Customer mental model:

`Potrebujem prácu → vyberám remeselníka → dostávam ponuky → dohodli sme sa → práca prebieha → hotovo → hodnotím`

Craftsman mental model:

`Dostanem pozvánku → rozhodnem sa → pošlem ponuku → získam zákazku → realizujem → dokončím → budujem overenú reputáciu`

Do not expose raw state-machine enum names when a correct human label already exists or can be derived without changing semantics.

Every primary screen should make the next relevant action understandable.

---

## 9. Trust semantics are part of the design

The design distinguishes:

- **Overené platformou**
- **Podporené dôkazmi**
- **Uvádza remeselník / Vlastné vyhlásenie — neoverené**

These are not decorative badge variants. They communicate different provenance strength.

Do not visually collapse them into one generic green "verified" treatment.

Do not present self-declared portfolio work as verified completed-job evidence.

Do not invent verification.

Do not fabricate ratings, reviews, completed-job counts, distances, qualifications or other trust facts.

---

## 10. Primary implementation scope

Implement the approved design first on the four reference experiences:

1. Homepage `/`
2. Craftsman search `/remeselnici`
3. Public craftsman profile `/remeselnici/[profileId]`
4. Confirmed Job cockpit `/zakazky/[jobId]`

Then propagate the same design system consistently through current Web Alpha flows, prioritizing:

- request/demand wizard `/dopyt`,
- authenticated overview/dashboard/navigation,
- Quote comparison/acceptance,
- authentication/onboarding,
- craftsman profile authoring,
- portfolio authoring,
- credential/evidence authoring if present,
- notifications/account/privacy screens,
- other R1–R4 transactional surfaces.

Do not remove capabilities simply because they are not visible in the reference board. The reference defines visual culture and primary composition, not a reduction in product scope.

---

## 11. Page-specific design requirements

### Homepage

Match the approved composition:

- white header on warm page canvas,
- serif hero headline,
- two primary user paths,
- green customer CTA,
- lighter/outlined craftsman CTA with terracotta accent,
- warm real-workshop photographic direction,
- simple how-it-works sequence,
- trust/social-proof region below.

Do not expose alpha/API implementation information as the main public homepage content.

Do not hard-code illustrative aggregate numbers unless they are real backend facts.

### Search

Match:

- serif page heading,
- compact filter surface,
- profession/locality-first controls,
- 3-column desktop result grid,
- white result cards,
- portrait + name + verification + rating metadata,
- concise services/skills line,
- `Prečo sa hodí?` explanatory inset,
- shortlist/save action,
- green profile action.

Do not add a "best" winner badge.

### Public profile

Match:

- large rectangular portrait,
- identity/trust summary,
- primary action hierarchy,
- trust fact row,
- clear section/tab structure,
- image-first portfolio gallery,
- provenance labels.

Avoid turning the profile into a long unstructured list of backend facts.

### Job cockpit

Match:

- title/status header,
- macro progress tracker,
- section tabs,
- next-action-first main card,
- quick actions column,
- chronological timeline.

On smaller screens, stack with the next action first.

The Job page must remain a central project cockpit rather than a database record page.

---

## 12. Responsive behavior

There is no approved mobile screenshot.

Therefore mobile is a conservative derivation of the approved desktop system, not a new creative task.

Preserve:

- color system,
- font families,
- typographic hierarchy,
- trust semantics,
- icon assets,
- visual rhythm,
- CTA priority,
- content order.

At minimum verify:

- `1440 × 900` desktop,
- `390 × 844` mobile.

Do not create a completely different mobile visual language.

---

## 13. Implementation strategy

Do not perform a single high-risk all-at-once rewrite.

Use staged implementation while preserving the same approved design direction throughout.

Recommended sequence:

### Phase 1 — audit and design foundation

- audit existing web screens against this handoff,
- identify current global CSS/theme/primitives,
- integrate locked design tokens,
- add supplied assets to the actual web asset path without modifying source assets,
- create/refactor reusable visual primitives.

Expected reusable primitives may include:

- AppShell
- PublicHeader
- AuthenticatedHeader
- Button variants
- IconButton
- FormField
- Card
- TrustBadge
- StatusBadge
- Tabs
- Stepper
- Timeline
- NextActionCard
- SearchResultCard
- ProfileHero
- SectionHeader
- EmptyState
- Notice/Alert

Do not create abstractions merely for abstraction's sake. Reuse should serve fidelity and consistency.

### Phase 2 — primary reference screens

Implement:

1. homepage,
2. search,
3. public profile,
4. Job cockpit.

Run the screenshot loop for each before considering this phase complete.

### Phase 3 — core workflow consistency

Apply the same system to request, quote, onboarding, craftsman authoring and other main R4 screens.

### Phase 4 — responsive/accessibility/consistency pass

- narrow mobile,
- keyboard navigation,
- focus visibility,
- error states,
- long Slovak strings,
- loading/empty states,
- real data variance.

---

# 14. Mandatory screenshot comparison loop

The implementation is not finished merely because the page renders without errors.

Visual fidelity to the supplied reference is part of the acceptance criteria.

For every primary reference page you MUST:

1. run the current project/release candidate,
2. open the real page in a browser,
3. use viewport `1440 × 900`, scale factor 1, zoom 100%,
4. use the existing synthetic test fixture/account where authentication is required,
5. capture a screenshot,
6. compare it to the matching file in `HANDOFF_ROOT/reference/`,
7. also inspect the full `reference-desktop-board.png`,
8. identify the largest visual mismatches,
9. modify the implementation,
10. capture another screenshot,
11. repeat until the result is visually close.

Use Playwright if available; this repository already has browser E2E infrastructure.

Store local screenshots under a gitignored directory such as:

`artifacts/design-compare/`

Never commit screenshots containing real personal data, secrets, OTPs, session material, signed media URLs or credentials.

### Every comparison must inspect

- overall composition,
- element positions,
- widths,
- heights,
- hero height,
- card dimensions,
- padding,
- margins,
- gaps,
- font family,
- font size,
- font weight,
- line-height,
- letter-spacing,
- line wrapping,
- exact token colors,
- border radius,
- borders,
- shadows,
- icon size,
- icon position/baseline,
- image crop,
- object position,
- vertical rhythm,
- trust badge appearance,
- primary action prominence.

At least one corrective screenshot pass is required whenever meaningful differences exist.

Do not claim visual completion based only on unit tests.

---

## 15. Dynamic content and visual fidelity

The reference board contains illustrative content.

Do not hard-code demo names, ratings, counts or metrics into production merely to match the screenshot.

For visual QA:

- use existing synthetic data,
- optionally create test-only fixture strings of similar visual length if repository rules allow it,
- never let test fixture content alter production domain behavior.

When text differs, match the component geometry, hierarchy, wrapping behavior and spacing rather than falsifying data.

---

## 16. Engineering/testing constraints

All relevant existing tests must stay green.

Do not weaken:

- authorization,
- CSRF protection,
- privacy boundaries,
- sealed-review behavior,
- contact/address privacy,
- competitor isolation,
- idempotency,
- race handling,
- media access rules,
- audit history,
- immutable accepted snapshots.

The redesign must not require database intervention for normal user flows.

Do not create production provider credentials or deployment resources as part of this design task.

The existing notebook + Docker + Quick Tunnel target is sufficient for current visual/manual testing.

---

## 17. What you must NOT do

You MUST NOT:

- redesign the logo,
- pick a new color palette,
- replace the serif heading style with generic sans-serif,
- import an icon library to replace supplied icons,
- use emoji as UI icons,
- invent a new homepage composition,
- convert cards into glassmorphism,
- add gradients not present in the reference,
- add excessive animations,
- make the design look like a generic dashboard/SaaS template,
- remove domain functionality because it complicates the layout,
- change locked product rules,
- expose internal enum names or database/entity terminology unnecessarily,
- hard-code fake trust facts.

---

## 18. Documentation/checkpoint

Before changing many screens, create or update a concise implementation checkpoint in the repository describing:

- current UI audit,
- design-system foundation work,
- primary screens migrated,
- visual comparison status per screen,
- known fidelity gaps,
- remaining responsive/accessibility work.

Do not rewrite locked canonical product specifications merely to record design progress.

---

## 19. Completion decision

Before declaring the task complete, read `HANDOFF_ROOT/ACCEPTANCE_CRITERIA.md` and explicitly verify every applicable checkbox.

The redesign is complete only when:

- supplied assets are used correctly,
- colors match locked tokens,
- typography matches the locked system,
- primary geometry matches the approved references closely,
- homepage/search/profile/Job cockpit have each gone through the screenshot comparison loop,
- responsive layout works,
- accessibility remains usable,
- existing product/security tests remain green,
- no unauthorized redesign occurred.

**The implementation is not finished merely because the page renders without errors.**

**Visual fidelity to the supplied reference is part of the acceptance criteria.**

Start by auditing the current web UI against this handoff, write a short execution checkpoint, then begin Phase 1 immediately. Work autonomously. Stop only for a genuine HUMAN GATE already defined by repository instructions.
