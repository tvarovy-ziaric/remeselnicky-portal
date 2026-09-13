# Canonical product sources

This directory stores compressed, hash-verified source bundles for the locked product definition and implementation backlog.

Do not edit the `.gz` files by hand.

Materialize readable working copies at repository root with:

```bash
./scripts/materialize-canonical-specs.sh
```

The script verifies both compressed and decompressed SHA-256 hashes before Codex uses the files.

Canonical outputs:
- `ROADMAP.md` — D01–D30 locked product/domain definition.
- `IMPLEMENTATION_BACKLOG.md` — autonomous R0–R4 execution graph and HUMAN GATE rules.

If verification fails, stop. A hash mismatch means the local product source cannot be trusted as canonical.
