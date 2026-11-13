#!/bin/bash
# Installs the pinned, notarized upstream Cua driver that Manor's computer connector runs.
#
#   pnpm --filter @manor/server provision:computer
#
# The grants (Accessibility, Screen Recording) belong to CuaDriver.app itself, because
# `cua-driver mcp` launches its daemon through LaunchServices. That is why this is the
# upstream Developer ID build and not a local patch: a rebuilt, ad-hoc signed copy loses
# its grants. Undo with `rm -rf /Applications/CuaDriver.app`.
set -euo pipefail

VERSION="0.28.2"
ASSET="cua-driver-rs-${VERSION}-darwin-arm64.tar.gz"
SHA256="818ddefa0fa8ba2ec9cba837c7aa634a4b064221c748752cf49c5b08e2c94e8c"
TEAM_ID="YCK386LBJ7"
URL="https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/${ASSET}"
TARGET="/Applications/CuaDriver.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Computer use is macOS only." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL "$URL" -o "$work/$ASSET"
actual="$(shasum -a 256 "$work/$ASSET" | awk '{print $1}')"
if [[ "$actual" != "$SHA256" ]]; then
  echo "Checksum mismatch for $ASSET: $actual" >&2
  exit 1
fi
tar -xzf "$work/$ASSET" -C "$work"
app="$work/cua-driver-rs-${VERSION}-darwin-arm64/CuaDriver.app"
codesign --verify --deep --strict "$app"
team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
if [[ "$team" != "$TEAM_ID" ]]; then
  echo "Unexpected signing team: ${team:-none}" >&2
  exit 1
fi
spctl -a -t exec "$app"

if [[ -d "$TARGET" ]]; then
  "$TARGET/Contents/MacOS/cua-driver" stop >/dev/null 2>&1 || true
  rm -rf "$TARGET"
fi
ditto "$app" "$TARGET"
"$TARGET/Contents/MacOS/cua-driver" telemetry disable >/dev/null
echo "Installed CuaDriver $VERSION at $TARGET (telemetry off)."
echo "Grant access with: $TARGET/Contents/MacOS/cua-driver permissions grant"
# A daemon started before the grants keeps answering permissions_pending (exit 75).
echo "Then restart its daemon once: $TARGET/Contents/MacOS/cua-driver stop"
