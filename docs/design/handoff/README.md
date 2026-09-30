# Remeselnícky portál — design-to-code handoff

This package freezes the approved ChatGPT visual direction into implementation-ready references, design tokens, component geometry, assets and a Codex execution prompt.

## Source of truth

The visual design is **not a suggestion**. It is the source of truth for the redesign.

Primary visual reference:

- `reference/reference-desktop.png` (conventional alias)
- `reference/reference-desktop-board.png` (same approved master board)

Design-system reference:

- `reference/reference-design-system.png`

Page-focused reference crops (with optional `-2x` upscaled inspection copies):

- `reference/reference-homepage-above-fold.png`
- `reference/reference-search-above-fold.png`
- `reference/reference-profile-above-fold.png`
- `reference/reference-job-above-fold.png`

Read `reference/REFERENCE_NOTES.md` before implementation so board annotations are not mistaken for application UI.

## Main files

- `CODEX_PROMPT.md` — the main instruction file to give Codex.
- `DESIGN_SYSTEM.md` — locked visual language, colors, typography and design rules.
- `ASSET_MANIFEST.md` — exact asset purpose and substitution restrictions.
- `ACCEPTANCE_CRITERIA.md` — completion checklist.
- `design/tokens.css` — implementation CSS tokens.
- `design/tokens.json` — machine-readable token mirror.
- `design/design-manifest.json` — machine-readable summary.
- `design/component-specs.md` — geometry and component-level implementation detail.
- `design/visual-comparison.md` — mandatory screenshot comparison workflow.

## Recommended repository placement

Unpack the folder into the project at:

`docs/design/handoff/`

The resulting structure should look like:

```text
docs/design/handoff/
├── README.md
├── CODEX_PROMPT.md
├── DESIGN_SYSTEM.md
├── ASSET_MANIFEST.md
├── ACCEPTANCE_CRITERIA.md
├── reference/
├── assets/
└── design/
```

Then give Codex the instruction:

> Read and execute `docs/design/handoff/CODEX_PROMPT.md`.

It is also recommended to add a short pointer in root `AGENTS.md` saying this handoff is the UI/UX source of truth for the redesign, while locked D01–D30 rules remain superior for product/security/privacy semantics.

## Important implementation principle

**Do not redesign. Implement.**

Codex is responsible for:

- component construction,
- integration into the existing Next.js/React/TypeScript web application,
- responsive behavior,
- accessibility,
- browser testing,
- visual convergence against the supplied references.

Codex is not responsible for inventing a different logo, palette, icon family, composition or visual direction.

## Fonts

Font files are intentionally not included.

- UI font: `Inter`.
- Display font: `Source Serif 4` as a documented technical approximation of the approved raster display typeface.

Use normal framework/web-font loading mechanisms; do not add font binaries to this handoff.

## Reference limitations

The approved design is a generated raster board rather than a Figma source file. The handoff therefore distinguishes:

- exact locked values where the design explicitly provides them,
- exact delivered assets,
- measured/derived geometry,
- clearly marked typography/geometry approximations.

Do not silently reinterpret approximation as permission to redesign.
