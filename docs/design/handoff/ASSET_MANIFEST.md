# Asset manifest

**ASSETS ARE AUTHORITATIVE.**

If an implementation asset exists in `assets/`, Codex must use that file for the matching purpose. It must not replace it with emoji, Unicode symbols, icon-library substitutes, or a newly drawn alternative.

## Brand

### `assets/logo-symbol.svg`
- Purpose: primary Remeselnícky portál symbol used in navbar/brand lockup.
- Source: technical vector reconstruction from the approved raster reference because the original vector source does not exist.
- Used in: public header, authenticated header, brand lockup.
- Do not modify: **YES**.
- Do not recolor: **YES**.
- Do not stretch: **YES**.

### `assets/logo-lockup-reference.png`
- Purpose: exact raster crop of the compact approved logo lockup from the design-system board; visual QA only.
- Used in: navbar/wordmark spacing comparison.
- Production rendering: use `logo-symbol.svg` plus locked display typography so the brand remains sharp and accessible.
- Do not modify: **YES**.

### `assets/logo-symbol-reference.png`
- Purpose: exact raster crop of the approved symbol; visual cross-check against the technical SVG reconstruction.
- Used in: asset QA only.
- Do not modify: **YES**.

### `assets/brand-wordmark-reference.png`
- Purpose: visual reference for brand-name typography and spacing.
- Source: exact crop from the approved design-system board.
- Used in: visual QA only.
- Production rendering: use the locked display font + `logo-symbol.svg`, not this raster crop as the accessible navbar text.
- Do not modify: **YES**.

## Locked interface icons

All SVG icons below are authoritative handoff assets. Their geometry must not be replaced with Lucide, Heroicons, FontAwesome, emoji or Unicode characters.

### `assets/icon-search.svg`
- Purpose: search action.
- Used in: navbar/search controls.
- Do not substitute: **YES**.

### `assets/icon-location.svg`
- Purpose: locality/distance indicator.
- Used in: search cards, profile metadata.
- Do not substitute: **YES**.

### `assets/icon-shield-check.svg`
- Purpose: platform verification/trust indicator.
- Used in: verified badges, trust facts.
- Do not substitute: **YES**.

### `assets/icon-heart.svg`
- Purpose: shortlist/save action.
- Used in: search cards/profile.
- Do not substitute: **YES**.

### `assets/icon-star.svg`
- Purpose: rating star.
- Used in: cards/profile/reviews.
- Do not replace with Unicode `★`: **YES**.

### `assets/icon-message.svg`
- Purpose: conversation/message action.
- Used in: job/profile quick actions where semantically correct.
- Do not substitute: **YES**.

### `assets/icon-file.svg`
- Purpose: documents/attachments.
- Used in: job/document flows.
- Do not substitute: **YES**.

### `assets/icon-users.svg`
- Purpose: participants/team.
- Used in: Job participant/workgroup areas.
- Do not substitute: **YES**.

### `assets/icon-home.svg`
- Purpose: job/home contextual mark visible in the approved Job cockpit.
- Used in: Job overview heading block.
- Do not substitute: **YES**.

### `assets/icon-change.svg`
- Purpose: change/change-order action.
- Used in: Job change controls.
- Do not substitute: **YES**.

### `assets/icon-bell.svg`
- Purpose: notifications.
- Used in: authenticated header/notification entry.
- Do not substitute: **YES**.

### `assets/icon-arrow-right.svg`
- Purpose: trailing arrow on primary CTA.
- Used in: buttons/links matching the reference.
- Do not substitute: **YES**.

### `assets/icon-check.svg`
- Purpose: compact completion/check state where the reference uses a check.
- Used in: stepper/status marks.
- Do not substitute: **YES**.

## Reference/content imagery

These images are exact crops from the approved generated design. They preserve the approved visual tone, but they are **not product facts**.

### `assets/hero-workshop-reference.webp`
- Purpose: reference for the warm workshop photography used in the homepage hero.
- Used in: **visual fixture / design QA only**.
- Important: the crop is a fragment of the approved composite image and includes embedded UI/text from the concept. Do not use it as a production hero photograph.
- Do not alter color treatment: **YES**.

### `assets/texture-wood-shavings-reference.webp`
- Purpose: reference for the warm woodworking material/detail imagery in the design culture board.
- Used in: optional brand/marketing decorative context only if the UI reference calls for it.
- Do not add it to operational screens just because it exists.

### `assets/profile-portrait-reference.webp`
- Purpose: test/demo visual fixture for profile composition.
- Production meaning: none; user/provider portrait must remain data-driven.

### `assets/portfolio-reference-01.webp` ... `04.webp`
- Purpose: test/demo fixture for portfolio gallery geometry.
- Production meaning: none; portfolio imagery must remain data-driven.

## Important distinction

The raster design contains photography, handwritten board annotations and demo content. Do not turn board annotations into production assets. Only the assets explicitly listed above are approved for implementation use.
