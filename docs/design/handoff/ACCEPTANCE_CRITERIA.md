# Acceptance criteria

Codex must not mark the redesign complete until all applicable items are satisfied.

## A. Source-of-truth compliance

- [ ] `reference/reference-desktop-board.png` was reviewed before implementation.
- [ ] `reference/reference-design-system.png` was reviewed before implementation.
- [ ] Page-specific reference crops were used during visual QA.
- [ ] Board annotations were not accidentally implemented as product UI.
- [ ] The implementation follows the approved visual direction rather than a new interpretation.

## B. Asset lock

- [ ] `assets/logo-symbol.svg` is used for the brand symbol.
- [ ] No emoji is used in place of supplied icons.
- [ ] No Unicode star/heart/check is used in place of supplied icon assets where a matching asset exists.
- [ ] No Lucide/Heroicons/FontAwesome substitute replaces a supplied asset.
- [ ] Supplied asset proportions are unchanged.
- [ ] Supplied asset colors are unchanged, except where the manifest explicitly describes an icon as semantic/extendable.
- [ ] Any genuinely new required icon is documented and matches the locked icon geometry rather than introducing a new icon style.

## C. Color lock

- [ ] Exact token values from `design/tokens.css` are used.
- [ ] No unapproved saturated brand colors were added.
- [ ] No generic SaaS blue/purple gradient was added.
- [ ] Main page background remains warm `#F7F5F0`.
- [ ] Text uses the locked graphite system rather than pure black.
- [ ] Trust/evidence/self-declared states preserve their semantic color distinctions.

## D. Typography lock

- [ ] Operational UI uses Inter.
- [ ] Display/marketing headings use Source Serif 4 (documented approximation) or the exact later-approved replacement if supplied by the user.
- [ ] Heading size/weight/line-height follow tokens.
- [ ] Navigation, labels and button typography follow tokens.
- [ ] Typography was not arbitrarily changed to solve layout issues.
- [ ] Desktop hero headline preserves the intended line count/visual weight.

## E. Geometry lock

- [ ] Desktop content max width is approximately 1200px as specified.
- [ ] Header height matches the specification.
- [ ] Primary/secondary button heights and radii match.
- [ ] Standard cards use the specified border/radius/shadow system.
- [ ] Search results preserve the approved 3-column desktop density.
- [ ] Craftsman profile preserves the approved portrait/identity/gallery hierarchy.
- [ ] Job page preserves the approved progress + next-action + quick-actions + timeline hierarchy.
- [ ] Geometry was not normalized to arbitrary framework defaults simply because they are conventional.

## F. Product semantics and trust

- [ ] No fake ratings, distances, counts or verification facts are hard-coded into production UI.
- [ ] Self-declared work is visibly distinct from platform-verified completed work.
- [ ] Evidence-supported status is not presented as stronger than the domain allows.
- [ ] Raw enum/state names are not exposed when a human-readable label exists.
- [ ] Quote comparison remains neutral and does not invent a winner/best offer.
- [ ] Existing privacy/authorization/state-machine boundaries remain intact.

## G. Primary screens

### Homepage
- [ ] Customer and craftsman paths are both visible as primary choices.
- [ ] The process is understandable without knowledge of backend entities.
- [ ] Hero composition, typography and warm workshop tone match the reference.

### Search
- [ ] Filters are visually grouped as in the reference.
- [ ] Result cards have portrait, identity, trust facts, fit/reason panel and actions.
- [ ] Save/shortlist and profile actions are clearly differentiated.

### Public profile
- [ ] Profile hero matches the reference hierarchy.
- [ ] Trust facts are scannable.
- [ ] Portfolio is image-first.
- [ ] Profile sections/tabs remain understandable on mobile.

### Job cockpit
- [ ] Macro progress is visible.
- [ ] `Čo treba urobiť teraz?` / next-best-action is the primary operational card.
- [ ] Quick actions and timeline are secondary supporting regions.
- [ ] Existing Job capabilities remain available; redesign did not remove them.

## H. Responsive and accessibility

- [ ] 1440×900 desktop implementation is visually checked.
- [ ] 390×844 responsive implementation is manually checked.
- [ ] Keyboard navigation works on primary flows.
- [ ] Focus states are visible.
- [ ] Form labels/errors remain associated and readable.
- [ ] Status is not conveyed by color alone.
- [ ] Tap targets are usable on mobile.
- [ ] No desktop-only overflow breaks core flows.

## I. Mandatory screenshot comparison loop

For each primary page:

- [ ] A browser screenshot was captured after the first implementation pass.
- [ ] It was compared to the supplied reference.
- [ ] Differences were explicitly identified.
- [ ] At least one visual correction pass was performed where differences existed.
- [ ] A new screenshot was captured after corrections.
- [ ] Final differences are minor, documented, and attributable only to dynamic real product content or clearly documented approximation.

The implementation is **not complete** merely because it compiles, tests pass, or the page renders without errors.

## J. Engineering integrity

- [ ] Existing relevant unit/integration/E2E tests remain green.
- [ ] Locked D01–D30 behavior was not changed for visual convenience.
- [ ] No auth/privacy/security guard was weakened.
- [ ] No new paid provider/account/credential requirement was introduced as part of the redesign.
- [ ] No production launch decision was made.
- [ ] Visual artifacts/screenshots containing real secrets or personal data were not committed.
