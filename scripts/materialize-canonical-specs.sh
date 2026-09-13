#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/docs/_source"

ROADMAP_GZ="$SOURCE_DIR/ROADMAP.md.gz"
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

for file in "$ROADMAP_GZ" "$BACKLOG_GZ"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: missing canonical source bundle: $file" >&2
    exit 1
  fi
done

verify_hash "$ROADMAP_GZ" "$ROADMAP_GZ_SHA"
verify_hash "$BACKLOG_GZ" "$BACKLOG_GZ_SHA"

gzip -dc "$ROADMAP_GZ" > "$ROADMAP_OUT"
gzip -dc "$BACKLOG_GZ" > "$BACKLOG_OUT"

verify_hash "$ROADMAP_OUT" "$ROADMAP_SHA"
verify_hash "$BACKLOG_OUT" "$BACKLOG_SHA"

echo "Canonical specs materialized and verified:"
echo "  ROADMAP.md                 $ROADMAP_SHA"
echo "  IMPLEMENTATION_BACKLOG.md  $BACKLOG_SHA"
