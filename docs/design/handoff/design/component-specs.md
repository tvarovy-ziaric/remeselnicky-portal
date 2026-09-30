# Component specifications

This file converts the approved visual reference into implementation geometry. Values marked **exact** come directly from the design-system board or locked handoff tokens. Values marked **derived** are measured/estimated from the raster reference and are intentionally documented rather than silently invented.

## 1. Global page shell

### Desktop
- Max content width: `1200px` **exact token**.
- Outer page background: `#F7F5F0`.
- Content surfaces: `#FFFFFF`.
- Horizontal viewport padding: `24px`.
- Major section vertical gap: `40–56px` depending on reference density.
- Main cards: `12px` radius, soft border `#D8D3C8`, subtle shadow.

### Header/navbar
- Height: `72px` desktop, `64px` mobile.
- White/surface background.
- Bottom divider: `1px solid #E8E3D9` or visually equivalent faint boundary.
- Logo left aligned; navigation follows with generous whitespace.
- Right side: search icon where relevant, secondary auth button, primary CTA.
- Primary CTA uses green fill and white text.
- Nav text 13px/500 Inter.
- No oversized mega-nav.

## 2. Brand lockup

### Symbol
- Use `../assets/logo-symbol.svg`.
- Desktop header symbol target: `30–34px` square.
- Do not stretch.
- Keep original terracotta color.

### Wordmark
- Render `Remeselnícky portál` beside the symbol using display serif.
- Desktop target: ~`20px`, 700.
- Gap from symbol: `10px`.
- Do not replace with a generic company logo.

## 3. Buttons

### Primary button
- Height: `44px`; hero primary may use `50px`.
- Horizontal padding: `18–22px`.
- Radius: `8px`.
- Background: `#285C4D`.
- Text: white, 14px/650 Inter.
- Optional trailing `icon-arrow-right.svg` at 16–18px.
- Hover: `#224E42` only; do not brighten or saturate.
- Focus: visible trust-blue focus ring.

### Secondary button
- Height: `44px`.
- White/surface background.
- Border: `1px solid #285C4D` for strong secondary CTA, otherwise `#D8D3C8`.
- Text: `#202523` or primary green depending on reference context.
- Radius: `8px`.

### Icon-only control
- Minimum target: `40×40px`.
- Border: `1px solid #D8D3C8` when outlined.
- Radius: `8px`.
- Do not use emoji.

## 4. Inputs and filters

### Standard input/select
- Height: `44px`.
- White background.
- Border: `1px solid #D8D3C8`.
- Radius: `8px`.
- Text: 14–16px Inter.
- Label above: 13px/600.
- Left icon, if used: 16–18px with 10px gap.
- Focus: border `#356F8A` + focus ring.

### Search filter row
Reference: `reference-search-above-fold.png`.
- Desktop: horizontal multi-control row.
- Profession and locality are first-class filters and visually wider.
- Additional filters are compact controls.
- Primary `Hľadať` action pinned at the right end.
- Filter card itself is a white rounded surface on warm page background.
- Derived desktop gap: `10–12px`.
- Do not turn the whole row into a dark search bar.

## 5. Homepage

Reference: `reference-homepage-above-fold.png`.

### Composition
- Header at top.
- Main hero immediately below.
- Two-column composition: copy/action area left, workshop imagery right.
- Derived split: approximately `58% / 42%`.
- Hero minimum height: `430px`.
- Hero corner radius: `18–21px` if enclosed as a card/surface.
- Copy max width: ~`560px`.

### Hero heading
- Display serif.
- 52px desktop, ~1.04 line-height.
- 2–3 lines at the approved width.
- Text color `#202523`.
- Avoid ultra-wide line length that collapses the intended wrap.

### Hero actions
- Two primary paths visible together:
  - customer path is filled primary green,
  - craftsman path is secondary outlined / light surface with terracotta accent.
- Buttons are large enough to read as the two key product choices.
- Derived gap: `12px`.

### Hero imagery
- The approved design uses warm real-workshop photography, not abstract illustration.
- `hero-workshop-reference.webp` is a content-reference crop, not a mandatory production photo.
- If the actual implementation already has a product-approved hero photo, it may remain only if crop/tone match the reference direction.
- Do not substitute a bright blue stock-SaaS illustration.

### How-it-works strip
- Directly below hero.
- Four horizontally aligned steps on desktop.
- Each step: circular soft icon container + step number + concise label + helper text.
- Mobile: stack or horizontally scroll only if necessary; preserve order.

### Social-proof strip
- Low-height white cards/tiles.
- Demo metrics in the reference are placeholders, not hardcoded product facts.
- If real aggregate metrics are unavailable, use trust explanations or remove metric values rather than fabricate counts.

## 6. Search results page

Reference: `reference-search-above-fold.png`.

### Page title
- Display serif H1 ~40px.
- Supporting line underneath in muted text.

### Result controls
- Filter surface under title.
- Result count left; sort and view controls right on desktop.
- Avoid excessive chrome.

### Results grid
- Desktop: 3 columns.
- Gap: `16px` derived.
- Cards equal height within row when practical.
- Minimum card width: ~`310px`.
- Tablet: 2 columns.
- Mobile: 1 column.

### Craftsman result card
- Surface: white.
- Border: `1px solid #E8E3D9`.
- Radius: `12px`.
- Shadow: standard card shadow, subtle.
- Internal padding: `14–16px`.
- Portrait: approximately `72×72px`, radius `10–12px`, object-cover.
- Name: 18–20px, strong.
- Verification badge adjacent but not visually louder than name.
- Rating uses `icon-star.svg`; never Unicode `★` in final implementation.
- Metadata uses location icon and muted text.
- Skills/services appear as a short readable line, not a tag explosion.
- `Prečo sa hodí?` is a subtle inset panel, not an algorithmic winner badge.
- Footer: shortlist/heart secondary action + green `Zobraziť profil` primary action.

## 7. Public craftsman profile

Reference: `reference-profile-above-fold.png`.

### Profile hero
- Desktop two-zone header: portrait left, identity/actions center/right.
- Portrait target: `176×176px` derived.
- Rounded rectangle, not a circular social avatar.
- Name: display serif 34–40px depending on available width.
- Verified mark immediately adjacent when true.
- Rating and response/location metadata under name.
- Main action green; secondary quote/request action outlined.

### Trust fact row
- Four compact trust/stat items below hero identity.
- Uses soft circular/icon containers.
- Do not imply verification where domain data does not support it.

### Profile tabs
- `Prehľad`, `Realizácie`, `Hodnotenia`, `Odbornosť`.
- Horizontal on desktop, scrollable on narrow widths.
- Active tab: green/graphite emphasis plus understated bottom border.

### Portfolio gallery
- Image-first.
- Approved above-fold pattern shows multiple rectangular photos in a compact row.
- Radius ~`8px`.
- Object-fit cover.
- Self-declared projects must carry a neutral provenance label.
- Verified completed-job work uses the verified/evidence visual language only when supported.

## 8. Job cockpit / confirmed job page

Reference: `reference-job-above-fold.png`.

### Header block
- Home/job icon left in a warm soft square.
- Job title prominent, display serif ~28px.
- Status badge nearby, compact and semantic.
- Secondary action and overflow control at the right.

### Progress tracker
- Horizontal stepper directly below title area.
- Four major macro stages visible in approved design:
  1. confirmed,
  2. in progress,
  3. handover/completion,
  4. completed.
- Current stage green/blue emphasis according to semantics.
- Completed stages show a check/solid node.
- Inactive stages are neutral warm gray.
- Do not expose raw backend state names.

### Section tabs
- `Prehľad`, `Správy`, `Priebeh`, `Dokumenty`, `Účastníci`, `Zmeny` where capabilities exist.
- Preserve existing routes and permissions.

### Main overview grid
Desktop derived layout:
- left/main: `minmax(0, 1fr)`,
- quick-actions column: ~`260px`,
- timeline column: ~`300px`,
- gap: `16px`.

On tablet/mobile, stack with `Čo treba urobiť teraz?` first.

### Next-action card
- This is the primary ergonomic element.
- Header asks `Čo treba urobiť teraz?` or equivalent context-specific wording.
- Show a short explanation and ordered next actions.
- One action can be highlighted with a pale terracotta/primary inset depending on urgency.
- Never hide critical irreversible actions behind vague wording.

### Quick actions
- Vertical buttons, compact.
- Green filled only for the strongest next action; others outlined.

### Timeline
- Vertical line with small semantic nodes.
- Date/time secondary.
- Current/pending event clearly differentiated.
- Preserve chronological truth; no decorative reordering.

## 9. Trust badge component

### Verified
- Background `#E5F1EC`.
- Text `#285C4D`.
- `icon-shield-check.svg` or exact approved equivalent.
- Radius pill.
- 12–13px/600.

### Evidence-supported
- Background `#E7EFF5`.
- Text `#356F8A`.

### Self-declared
- Background `#F0ECE5` or approved warm neutral.
- Text `#5E6864`.

Status must never be communicated by color alone; icon/text remains required.

## 10. Cards

### Standard card
- White.
- `1px` faint/soft border.
- 12px radius.
- 16–24px padding based on density.
- Subtle shadow only where the reference shows elevation.

### Inset card
- Background `#F7F5F0` or a soft semantic background.
- 8–12px radius.
- No heavy shadow.

## 11. Responsive behavior

No approved mobile raster exists. Derive conservatively.

### <= 1023px
- Search grid: 2 columns.
- Job cockpit: main column first, supporting cards below.
- Homepage hero may remain two columns until layout becomes cramped.

### <= 639px
- One-column layout.
- Hide nonessential desktop nav links behind the existing accessible menu pattern if the app already has one; otherwise implement a simple accessible menu without changing visual language.
- Primary CTA remains visible.
- Search results 1 column.
- Profile portrait becomes ~112px.
- Tabs may horizontally scroll.
- Job stepper can compress labels or become a vertically readable stage list, but must preserve the same four-stage hierarchy.
- Primary workflow forms may use sticky bottom CTA where it does not obscure content.

## 12. States

### Hover
- Subtle border/shadow or approved darker primary shade.
- No scale-up gimmicks.

### Focus
- Always visible.
- Trust-blue focus ring.

### Disabled
- Maintain readable text.
- Do not reduce opacity so far that labels become inaccessible.

### Error
- Brick red + text explanation.
- No pure red neon treatment.

### Loading
- Calm skeletons/spinners using warm neutrals.
- No flashing or strong brand animations.
