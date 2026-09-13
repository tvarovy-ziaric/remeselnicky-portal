# Canonical product sources

This directory stores hash-verified source bundles for the locked product definition and implementation backlog.

Do not edit source bundles or split parts by hand.

Materialize readable working copies at repository root with:

```bash
./scripts/materialize-canonical-specs.sh
```

## ROADMAP transport

`ROADMAP.md` is stored as 13 files named `roadmap.b64.part-00` through `roadmap.b64.part-12`.

Each part is the base64 encoding of one consecutive binary slice of the canonical gzip stream. The parts **must be decoded individually and their decoded bytes appended in numeric order**. Concatenating the padded base64 text and decoding it as one stream is invalid and can truncate the gzip at the first padding boundary.

The materializer reconstructs the gzip and verifies its exact SHA-256 before decompression, then verifies the decompressed `ROADMAP.md` SHA-256 as a second integrity check.

## Backlog transport

`IMPLEMENTATION_BACKLOG.md.gz` remains a normal gzip bundle and is verified both before and after decompression.

Canonical outputs:
- `ROADMAP.md` — D01–D30 locked product/domain definition.
- `IMPLEMENTATION_BACKLOG.md` — autonomous R0–R4 execution graph and HUMAN GATE rules.

If any verification fails, stop. A hash mismatch means the product source cannot be trusted as canonical.
