#!/bin/bash
# Builds Manor's patched Cua driver and installs it as /Applications/CuaDriver.app.
#
#   pnpm --filter @manor/server build:computer
#
# The patches in ../patches/cua-driver apply to upstream cua-driver 0.28.2 (MIT,
# trycua/cua). The binary goes into the notarized upstream bundle skeleton, which is
# then re-signed with an Apple Development identity. macOS may require fresh
# Accessibility and Screen Recording grants after a native driver rebuild.
# The Cua-team entitlements that need their provisioning profile are dropped.
# Undo with `pnpm --filter @manor/server provision:computer`, which reinstalls upstream.
set -euo pipefail

COMMIT="fc188250b4ca8549b8e61f937fdb1fb560770e86"
RUST="1.97.1"
TARGET="/Applications/CuaDriver.app"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHES="$HERE/../patches/cua-driver"
SRC="${MANOR_CUA_SRC:-$HOME/.manor/cua-src}"
IDENTITY="${MANOR_CODESIGN_IDENTITY:-$(security find-identity -p codesigning -v | awk -F'"' '/Apple Development/ { print $2; exit }')}"
export PATH="$HOME/.cargo/bin:$PATH"

[[ "$(uname -s)" == "Darwin" ]] || { echo "Computer use is macOS only." >&2; exit 1; }
[[ -n "$IDENTITY" ]] || { echo "No Apple Development signing identity found; set MANOR_CODESIGN_IDENTITY." >&2; exit 1; }
command -v cargo >/dev/null || { echo "Install Rust first: https://rustup.rs (use --no-modify-path)." >&2; exit 1; }

if [[ ! -d "$SRC/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/trycua/cua.git "$SRC"
  git -C "$SRC" sparse-checkout set libs/cua-driver
fi
git -C "$SRC" fetch -q origin "$COMMIT" 2>/dev/null || true
git -C "$SRC" checkout -q --force "$COMMIT"
for patch in "$PATCHES"/*.patch; do git -C "$SRC" apply "$patch"; done

(cd "$SRC/libs/cua-driver/rust" && rustup toolchain install "$RUST" --profile minimal >/dev/null && cargo build --release -p cua-driver)
built="$SRC/libs/cua-driver/rust/target/release/cua-driver"

# The upstream bundle is the skeleton; provision it first if it is not there.
[[ -d "$TARGET" ]] || bash "$HERE/provision-computer.sh"
stage="$(mktemp -d)/CuaDriver.app"
trap 'rm -rf "$(dirname "$stage")"; git -C "$SRC" checkout -q --force "$COMMIT"' EXIT
ditto "$TARGET" "$stage"
rm -rf "$stage/Contents/_CodeSignature" "$stage/Contents/embedded.provisionprofile"
cp "$built" "$stage/Contents/MacOS/cua-driver"

entitlements="$(dirname "$stage")/entitlements.plist"
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
