# Reference notes

## Authoritative order

1. `reference-desktop.png` / `reference-desktop-board.png` — **primary visual source of truth** (identical approved master board). This is the last approved/current UI direction from the ChatGPT design work in this thread.
2. `reference-design-system.png` — authoritative for palette, trust language, component mood, spacing feel and the "modern workshop + trust + simplicity" culture.
3. Page crops — exact crops from `reference-desktop-board.png`, provided only to make visual comparison easier.

## Page crop mapping

| File | Source crop in primary board | Meaning |
|---|---:|---|
| `reference-homepage-above-fold.png` | x=210..906, y=101..540 | Homepage composition and visual hierarchy |
| `reference-search-above-fold.png` | x=921..1640, y=101..540 | Search/filter/results composition |
| `reference-profile-above-fold.png` | x=210..906, y=579..925 | Craftsman profile above-the-fold composition |
| `reference-job-above-fold.png` | x=921..1640, y=579..925 | Confirmed Job cockpit above-the-fold composition |

The page crops are not separate redesigns. They are literal extracts from the approved board.

## What is UI and what is board annotation

The following visible elements in the full board are **presentation annotations around the mockups and are NOT application UI**:

- the left column titled `Dizajnové zásady`,
- numbered board labels `01`, `02`, `03`, `04`,
- handwritten notes outside or overlapping the page frames,
- the blueprint-house sketch in the left margin,
- the large board-level brand header at the very top,
- board-level footer text.

Do not implement those annotations inside the product UI.

## Content versus design

The mockup contains illustrative/demo content such as names, counts and marketing statistics. The **visual structure is authoritative; demo facts are not product data**.

Examples that must not be hard-coded into production unless the real backend provides them:

- `12 500+ spokojných zákazníkov`,
- `4 800+ overených remeselníkov`,
- named demo craftsmen and their exact counts,
- exact quotes/testimonials,
- exact distances and ratings shown only for composition.

For screenshot comparison, test-only synthetic fixtures may use visually similar lengths. Production UI must render real backend data.

## Fidelity expectation

The reference is a generated visual design rather than a Figma file with inspectable vectors. Therefore:

- exact colors explicitly printed on the design-system board are locked,
- delivered image assets are locked,
- page composition and geometry should be reproduced closely,
- display font family and several geometry measurements are documented technical approximations,
- visual comparison is mandatory even where automated raw-pixel equality would be inappropriate because content is dynamic.

## High-resolution inspection copies

Files ending in `-2x.png` are Lanczos-upscaled copies of the exact approved page crops. They contain no new design information; they exist only to make zoomed inspection easier. The original crop remains authoritative.
