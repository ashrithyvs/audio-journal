#!/usr/bin/env bash
# Downloads the pinned libargon2 archive into a scratch directory, verifies
# its SHA-256, builds the host driver against it, and runs the cross-check.
# Usage: crosscheck.sh <scratch dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$1"
sha=daf972a89577f8772602bf2eb38b6a3dd3d922bf5724d45e7f9589b5e830442c
archive="$work/phc-winner-argon2-20190702.tar.gz"
mkdir -p "$work"
[ -f "$archive" ] || curl -fsSL -o "$archive" https://github.com/P-H-C/phc-winner-argon2/archive/refs/tags/20190702.tar.gz
echo "$sha  $archive" | sha256sum -c -
tar -xzf "$archive" -C "$work"
src="$work/phc-winner-argon2-20190702"
cc -O2 -std=c99 -I"$src/include" -I"$src/src" \
  "$here/argon2-hex.c" "$src/src/argon2.c" "$src/src/core.c" "$src/src/encoding.c" \
  "$src/src/ref.c" "$src/src/thread.c" "$src/src/blake2/blake2b.c" \
  -lpthread -o "$work/argon2-hex"
node "$here/crosscheck.mjs" "$work/argon2-hex"
