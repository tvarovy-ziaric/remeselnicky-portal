# Remeselnícky portál — approved design system

## 1. Design identity

The approved direction is **modern workshop + trust + simplicity**.

The interface should feel:

- warm rather than clinical,
- serious rather than corporate,
- crafted rather than decorative,
- calm rather than attention-seeking,
- trustworthy rather than gamified.

The approved reference deliberately avoids the stereotypical black/yellow "construction website" aesthetic and avoids generic SaaS blue/purple gradients.

## 2. Source-of-truth hierarchy

Visual truth is defined by:

1. `reference/reference-desktop-board.png`
2. `reference/reference-design-system.png`
3. page-specific crops in `reference/`
4. exact tokens in `design/tokens.css`
5. geometry/specification in `design/component-specs.md`

Where a prose sentence conflicts with a clearly visible reference, the reference wins unless that would violate a locked D01–D30 product/security/privacy rule.

## 3. Color system — COLOR LOCK

| Token | Value | Use |
|---|---:|---|
| Main background | `#F7F5F0` | page background, warm canvas |
| Soft background | `#EEE8DD` | low-emphasis sections/chips |
| Surface | `#FFFFFF` | cards and elevated panels |
| Primary text | `#202523` | headings/body text |
| Secondary text | `#5E6864` | supporting copy |
| Primary green | `#285C4D` | primary CTA, active states |
| Primary hover | `#224E42` | hover/pressed only |
| Accent terracotta | `#C66A42` | craft accent, secondary emphasis |
| Brand symbol terracotta | `#B06A45` | locked logo symbol |
| Trust blue | `#356F8A` | evidence/trust status |
| Success green | `#2F7A52` | positive status |
| Warning ochre | `#B4832E` | caution/pending |
| Error brick | `#B34A3C` | destructive/error |
| Soft border | `#D8D3C8` | standard card/control border |
| Faint border | `#E8E3D9` | subtle separators |

### Color lock rules

Do not:

- invent new brand colors,
- increase saturation to make the UI "more modern",
- introduce SaaS blue/purple gradients,
- use pure black `#000000` for normal UI,
- use pure white as the page background,
- recolor provided raster/SVG brand assets,
- convert the warm neutral system into cool gray.

If a new semantic state is unavoidable, first map it to an existing semantic token. Add a new token only if the locked product semantics genuinely require a distinct state.

## 4. Typography — TYPOGRAPHY LOCK

### UI family

`Inter` is explicitly named in the approved design-system board and is authoritative for operational UI.

Use Inter for:

- navigation,
- body text,
- form labels,
- buttons,
- metadata,
- badges,
- tables,
- controls.

### Display family

The approved UI board visibly uses a serif display face for brand/page/marketing headings. The exact original vector/font metadata does not exist in the generated image.

**Technical approximation:** `Source Serif 4`, fallback `Georgia`, `Times New Roman`, serif.

This approximation is locked for implementation unless the user later provides the original font identity.

### Scale

| Role | Family | Size | Line height | Weight | Letter spacing |
|---|---|---:|---:|---:|---:|
| Marketing display | Source Serif 4 | 52 px | 1.04 | 700 | -0.025em |
| Page H1 | Source Serif 4 | 40 px | 1.10 | 700 | -0.02em |
| H2 | Source Serif 4 | 28 px | 1.18 | 700 | -0.015em |
| H3 | Inter | 21 px | 1.25 | 650 | -0.01em |
| Body | Inter | 16 px | 1.50 | 400 | 0 |
| Secondary body | Inter | 14 px | 1.42 | 400 | 0 |
| Label | Inter | 13 px | 1.25 | 600 | 0 |
| Navigation | Inter | 13 px | 1.20 | 500 | 0 |
| Button | Inter | 14 px | 1.20 | 650 | 0 |

Do not improvise heading sizes to fit content. Preserve the scale and adjust available layout width before changing typography. Responsive reductions are specified in `tokens.css`.

## 5. Layout language — GEOMETRY LOCK

- Desktop content max width: `1200px`.
- Desktop horizontal padding: `24px`.
- Tablet padding: `20px`.
- Mobile padding: `16px`.
- Header height: `72px` desktop, `64px` mobile.
- Standard control height: `44px`.
- Large primary CTA: `50px` high.
- Standard card radius: `12px`.
- Hero/feature radius: `18–21px`.
- Standard card shadow: `0 8px 24px rgba(32,37,35,0.08)`.

The design uses real values such as 18px, 21px, 28px and 52px. Do not normalize everything to an 8px grid simply because it is conventional.

## 6. Trust language

Trust provenance must be visually obvious and semantically stable.

### Verified by platform

- green treatment,
- shield/check icon,
- wording equivalent to `Overené platformou` / `Overený remeselník` when factually true.

### Evidence-supported

- muted trust blue,
- evidence/proof meaning,
- never visually equal to full platform verification unless the domain says it is equivalent.

### Self-declared

- neutral warm-gray treatment,
- wording equivalent to `Uvádza remeselník` / `Vlastné vyhlásenie — neoverené`.

Never make a self-declared portfolio project visually look like verified completed Job evidence.

## 7. Brand asset rule

The brand symbol supplied in `assets/logo-symbol.svg` is the implementation asset. It is a technical vector reconstruction of the approved raster symbol because no original source vector exists.

It is now authoritative for this handoff.

Do not redraw it, replace it with tools/hammer emoji, or substitute an icon-library mark.

## 8. Icon language

The handoff includes a small locked icon family matching the approved thin-line UI direction. Use those exact files where their semantic purpose matches.

If a required icon does not exist:

1. first reuse an existing handoff icon if semantically correct,
2. otherwise create a new icon only if required by existing product functionality,
3. match the same 24×24, rounded 1.8px stroke system,
4. document it as an extension to the asset manifest.

Do not silently import Lucide, Heroicons or FontAwesome to replace supplied icons.

## 9. Motion

The reference does not establish a motion language. Keep motion restrained:

- hover/focus transitions: 120–180ms,
- no bouncy or springy marketing animations,
- no continuous decorative motion,
- respect `prefers-reduced-motion`.

## 10. Responsive philosophy

There is no approved mobile screenshot in the source material. Mobile behavior is therefore a **derived implementation**, not a new design direction.

Preserve:

- hierarchy,
- typography character,
- palette,
- trust semantics,
- primary action prominence,
- card geometry,
- content ordering.

Do not invent a visually unrelated mobile shell.
