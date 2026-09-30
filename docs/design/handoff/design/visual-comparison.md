# Mandatory screenshot comparison workflow

The implementation is not finished merely because the page renders without errors.

Visual fidelity to the supplied reference is part of the acceptance criteria.

## Reference set

Use:

- `../reference/reference-homepage-above-fold.png`
- `../reference/reference-search-above-fold.png`
- `../reference/reference-profile-above-fold.png`
- `../reference/reference-job-above-fold.png`

Keep `../reference/reference-desktop-board.png` open as the master composition reference.

## Required desktop viewport

Use Playwright or an equivalent real browser at:

- viewport: `1440 × 900`
- device scale factor: `1`
- default browser zoom: `100%`
- preferred engine for first pass: Chromium

Also spot-check Firefox and WebKit using the existing project setup where available.

## Required derived mobile viewport

No approved mobile raster exists. Use a conservative implementation check at:

- `390 × 844`

This is a functional/responsive check, not a pixel-match reference. Do not create a visually unrelated mobile redesign.

## Iteration loop

For each primary page:

1. Run the current application/release candidate.
2. Navigate to the page using the existing synthetic fixture/test identities.
3. Capture a 1440×900 screenshot.
4. Compare against the appropriate approved reference crop and the master board.
5. Write down the largest visual deviations.
6. Fix the implementation.
7. Capture a new screenshot.
8. Repeat until the differences are minor and explainable by dynamic product content.

Store local comparison output under a gitignored path such as:

`artifacts/design-compare/<page>/<iteration>.png`

Do not commit screenshots containing real personal data, credentials, signed URLs, tokens or private content.

## What to compare every iteration

- overall composition,
- header height,
- content max width,
- column proportions,
- hero height,
- relative location of primary CTA,
- card widths/heights,
- padding,
- margins,
- gaps,
- text wrapping,
- font family,
- font weight,
- font size,
- line-height,
- letter-spacing,
- exact token colors,
- border thickness,
- border radius,
- shadows,
- icon size,
- icon baseline/alignment,
- image crop/object-position,
- trust-badge treatment,
- vertical rhythm.

## Practical fidelity tolerances

The reference is a raster concept, not inspectable Figma geometry. Use these implementation tolerances:

- locked color token: **exact value**, no tolerance,
- locked asset: **exact file**, no substitution,
- header/control height: target ±2px,
- type size: target ±1px,
- major container edge: target ±8px relative to intended reference composition,
- card radius: target ±2px,
- gap/padding: target ±4px unless the reference clearly demands tighter matching,
- hero headline: preserve reference line count and approximate wrap at desktop,
- search cards: preserve reference 3-column density at desktop,
- Job overview: preserve next-action-first hierarchy.

## Dynamic-content exception

Do not fake backend facts just to match reference text.

If real/synthetic application data changes line lengths, compare:

- component geometry,
- typographic treatment,
- spacing,
- hierarchy,
- truncation/wrapping behavior.

For visual regression fixtures, synthetic strings of similar length may be used when they are clearly test-only and do not alter product behavior.
