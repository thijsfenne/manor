#!/bin/bash
# Builds Manor's patched Cua driver.
#
#   pnpm --filter @manor/server build:computer          installs it as /Applications/CuaDriver.app
#   bash build-computer-driver.sh --embed <dir>         writes the bare binary to <dir>/cua-driver
#
# The patches in ../patches/cua-driver apply to upstream cua-driver 0.28.2 (MIT,
# trycua/cua). Both modes build the same patched binary.
#
# Install mode is for a checkout: the binary goes into the notarized upstream bundle
# skeleton, which is re-signed with an Apple Development identity, and macOS may
# require fresh Accessibility and Screen Recording grants after each rebuild. The
# Cua-team entitlements that need their provisioning profile are dropped. Undo with
# `pnpm --filter @manor/server provision:computer`, which reinstalls upstream.
#
# Embed mode is for the release build: `release-mac.sh` puts the unsigned binary in
# Manor.app's Resources, where electron-builder signs it with Manor's identity, and
# Manor starts it as its own child so the grants are Manor's.
set -euo pipefail

COMMIT="fc188250b4ca8549b8e61f937fdb1fb560770e86"
# The pinned 1.97.1 links proc-macro dylibs that dyld on macOS 27 refuses to load.
RUST="1.100.0"
TARGET="/Applications/CuaDriver.app"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHES="$HERE/../patches/cua-driver"
SRC="${MANOR_CUA_SRC:-$HOME/.manor/cua-src}"
export PATH="$HOME/.cargo/bin:$PATH"

embed=""
if [[ "${1:-}" == "--embed" ]]; then
  [[ -n "${2:-}" ]] || { echo "Usage: $0 --embed <dir>" >&2; exit 2; }
  embed="$2"
fi

[[ "$(uname -s)" == "Darwin" ]] || { echo "Computer use is macOS only." >&2; exit 1; }
command -v rustup >/dev/null || { echo "Install Rust first: https://rustup.rs (use --no-modify-path)." >&2; exit 1; }
if [[ -z "$embed" ]]; then
  IDENTITY="${MANOR_CODESIGN_IDENTITY:-$(security find-identity -p codesigning -v | awk -F'"' '/Apple Development/ { print $2; exit }')}"
  [[ -n "$IDENTITY" ]] || { echo "No Apple Development signing identity found; set MANOR_CODESIGN_IDENTITY." >&2; exit 1; }
fi

if [[ ! -d "$SRC/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/trycua/cua.git "$SRC"
  git -C "$SRC" sparse-checkout set libs/cua-driver
fi
git -C "$SRC" fetch -q origin "$COMMIT" 2>/dev/null || true
git -C "$SRC" checkout -q --force "$COMMIT"
work="$(mktemp -d)"
trap 'rm -rf "$work"; git -C "$SRC" checkout -q --force "$COMMIT"' EXIT
for patch in "$PATCHES"/*.patch; do git -C "$SRC" apply "$patch"; done

# `+$RUST` overrides the checkout's rust-toolchain.toml.
(cd "$SRC/libs/cua-driver/rust" && rustup toolchain install "$RUST" --profile minimal >/dev/null && cargo "+$RUST" build --release -p cua-driver)
built="$SRC/libs/cua-driver/rust/target/release/cua-driver"

if [[ -n "$embed" ]]; then
  mkdir -p "$embed"
  rm -f "$embed/cua-driver"
  cp "$built" "$embed/cua-driver"
  echo "Wrote the patched Cua driver to $embed/cua-driver (unsigned)."
  exit 0
fi

# The upstream bundle is the skeleton; provision it first if it is not there.
[[ -d "$TARGET" ]] || bash "$HERE/provision-computer.sh"
stage="$work/CuaDriver.app"
ditto "$TARGET" "$stage"
rm -rf "$stage/Contents/_CodeSignature" "$stage/Contents/embedded.provisionprofile"
cp "$built" "$stage/Contents/MacOS/cua-driver"

entitlements="$work/entitlements.plist"
cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.automation.apple-events</key><true/>
  <key>com.apple.security.device.screen-capture</key><true/>
</dict></plist>
PLIST
codesign --force --options runtime --sign "$IDENTITY" "$stage/Contents/MacOS/cua-cursor-theme"
codesign --force --options runtime --entitlements "$entitlements" --sign "$IDENTITY" "$stage/Contents/MacOS/cua-driver"
codesign --force --options runtime --entitlements "$entitlements" --sign "$IDENTITY" "$stage"
codesign --verify --deep --strict "$stage"

"$TARGET/Contents/MacOS/cua-driver" stop >/dev/null 2>&1 || true
rm -rf "$TARGET"
ditto "$stage" "$TARGET"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$TARGET"
"$TARGET/Contents/MacOS/cua-driver" telemetry disable >/dev/null
echo "Installed patched CuaDriver at $TARGET, signed by: $IDENTITY"
echo "Check grants after each driver build: $TARGET/Contents/MacOS/cua-driver permissions grant, then $TARGET/Contents/MacOS/cua-driver stop"
