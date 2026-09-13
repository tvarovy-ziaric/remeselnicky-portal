#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/docs/_source"

BACKLOG_GZ="$SOURCE_DIR/IMPLEMENTATION_BACKLOG.md.gz"
ROADMAP_OUT="$ROOT_DIR/ROADMAP.md"
BACKLOG_OUT="$ROOT_DIR/IMPLEMENTATION_BACKLOG.md"

ROADMAP_SHA="5e50dadee6f9e2dce01c41bede7c270328e61c133e1aca362ba09751423b07ce"
BACKLOG_SHA="29734c4cb9aa9e726078aeba9addc54549017f4959232c2f49e1fda7df29cde3"
ROADMAP_GZ_SHA="d639d602b09f53281a067b9f66c937f03827b0ea2fa6a80b6b765284d0f9144b"
BACKLOG_GZ_SHA="fa379aac2665b7e7bbb129329d9e6d2e2bd1825b2c90a70fa265b68f8131fe79"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "ERROR: sha256sum or shasum is required" >&2
    exit 1
  fi
}

verify_hash() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(sha256_file "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: SHA-256 mismatch for $file" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
}

decode_base64_file() {
  local file="$1"
  if base64 --decode "$file" >/dev/null 2>&1; then
    base64 --decode "$file"
  elif base64 -D "$file" >/dev/null 2>&1; then
    base64 -D "$file"
  else
    echo "ERROR: unable to decode base64 source part: $file" >&2
    exit 1
  fi
}

if [[ ! -f "$BACKLOG_GZ" ]]; then
  echo "ERROR: missing canonical backlog bundle: $BACKLOG_GZ" >&2
  exit 1
fi

ROADMAP_TMP_GZ="$(mktemp "${TMPDIR:-/tmp}/remeselnicky-roadmap.XXXXXX")"
trap 'rm -f "$ROADMAP_TMP_GZ"' EXIT
: > "$ROADMAP_TMP_GZ"

for suffix in {00..12}; do
  part="$SOURCE_DIR/roadmap.b64.part-$suffix"
  if [[ ! -f "$part" ]]; then
    echo "ERROR: missing canonical roadmap source part: $part" >&2
    exit 1
  fi
  decode_base64_file "$part" >> "$ROADMAP_TMP_GZ"
done

# The split transport must reconstruct the exact original canonical gzip.
verify_hash "$ROADMAP_TMP_GZ" "$ROADMAP_GZ_SHA"
verify_hash "$BACKLOG_GZ" "$BACKLOG_GZ_SHA"

gzip -dc "$ROADMAP_TMP_GZ" > "$ROADMAP_OUT"
gzip -dc "$BACKLOG_GZ" > "$BACKLOG_OUT"

verify_hash "$ROADMAP_OUT" "$ROADMAP_SHA"
verify_hash "$BACKLOG_OUT" "$BACKLOG_SHA"

echo "Canonical specs materialized and verified:"
echo "  ROADMAP.md                 $ROADMAP_SHA"
echo "  IMPLEMENTATION_BACKLOG.md  $BACKLOG_SHA"
