#!/bin/bash
# Builds the release DMG of Manor.app for Apple Silicon into apps/desktop/release/.
# Run from the repo root via `pnpm desktop:release`. It never touches /Applications.
# It needs Rust (https://rustup.rs): the patched Cua driver is built and embedded in
# Resources/cua-driver, signed with the app, so Accessibility and Screen Recording are
# granted to Manor itself.
#
#   MANOR_SIGN_IDENTITY   a "Developer ID Application" identity in your keychain: its SHA-1
#                         hash, or its name without that prefix (`security find-identity -v -p codesigning`)
#   MANOR_NOTARY_PROFILE  a notarytool keychain profile (`xcrun notarytool store-credentials`)
#
# With both set, the app is signed with the hardened runtime, notarized and stapled,
# and the DMG is signed, notarized and stapled too. Otherwise the app inside the DMG
# is ad hoc signed, as `pnpm desktop:package` does: fine on the Mac that built it, not
# something to hand out.
#
# `--app` builds only release/mac-arm64/Manor.app, for `pnpm desktop:install`: signed
# with MANOR_SIGN_IDENTITY when set, never notarized (a local build carries no
# quarantine), ad hoc otherwise. Without Rust it leaves the driver out.
set -euo pipefail

app_only=""
[ "${1:-}" = "--app" ] && app_only=1

cd "$(dirname "$0")/.."
version="$(node -p "require('./package.json').version")"
app="release/mac-arm64/Manor.app"
dmg="release/Manor-$version-arm64.dmg"
identity="${MANOR_SIGN_IDENTITY:-}"
profile="${MANOR_NOTARY_PROFILE:-}"

driver_stage=".computer-driver"
driver="$app/Contents/Resources/cua-driver/cua-driver"

say() { printf '[release] %s\n' "$*"; }

# macOS keys Manor's grants to its team, so a driver from another signer would not run as Manor.
check_team() {
  codesign --verify --deep --strict "$app"
  local team driver_team
  team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  driver_team="$(codesign -dv "$driver" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  # codesign prints "not set" for an ad hoc signature, which carries no team at all.
  if [ -z "$team" ] || [ "$team" = "not set" ] || [ "$driver_team" != "$team" ]; then
    say "the embedded driver is signed by '${driver_team:-nobody}', the app by '${team:-nobody}'"
    exit 1
  fi
}

# electron-builder copies the staged driver from here (extraResources). Removed again on
# exit, so a later `pnpm desktop:package` does not pick up a stale copy.
rm -rf "$driver_stage"
trap 'rm -rf "$driver_stage"' EXIT
# The driver build looks for rustup in ~/.cargo/bin too.
if [ -n "$app_only" ] && ! PATH="$HOME/.cargo/bin:$PATH" command -v rustup >/dev/null; then
  say "no Rust: building without the embedded driver, so computer use keeps CuaDriver.app."
else
  bash ../server/scripts/build-computer-driver.sh --embed "$driver_stage"
fi
pnpm bundle:app
pnpm build

if [ -n "$app_only" ]; then
  if [ -n "$identity" ]; then
    # The same Developer ID on every install keeps the Accessibility and Screen Recording grants.
    pnpm exec electron-builder --mac dir --arm64 --publish never -c.mac.identity="$identity" -c.mac.notarize=false
    if [ -x "$driver" ]; then check_team; else codesign --verify --deep --strict "$app"; fi
    say "built $app (Developer ID signed, not notarized)"
  else
    pnpm exec electron-builder --mac dir --arm64 --publish never
    pnpm sign:mac
    say "built $app (ad hoc: macOS asks for its permissions again after every install)"
  fi
  exit 0
fi

rm -f "$dmg"

missing=()
[ -n "$identity" ] || missing+=(MANOR_SIGN_IDENTITY)
[ -n "$profile" ] || missing+=(MANOR_NOTARY_PROFILE)
if [ "${#missing[@]}" -gt 0 ]; then
  say "not set: ${missing[*]}. Building a DMG with an ad hoc signed app, not notarized."
  # build.mac.identity is null, so electron-builder neither signs nor notarizes.
  pnpm exec electron-builder --mac dir --arm64 --publish never
  pnpm sign:mac
  [ -x "$driver" ] || { say "the embedded driver is missing from $app"; exit 1; }
  pnpm exec electron-builder --mac dmg --arm64 --prepackaged "$app" --publish never
  say "built $dmg (ad hoc)"
  exit 0
fi

say "signing with the identity from MANOR_SIGN_IDENTITY, notarizing with the profile from MANOR_NOTARY_PROFILE."
# electron-builder signs the app, notarizes and staples it, then builds and signs the DMG
# from that stapled app. The DMG itself is notarized and stapled below. electron-builder
# prefers Apple ID and API key variables over a keychain profile, so those are unset.
env -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER -u APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE="$profile" \
  pnpm exec electron-builder --mac dmg --arm64 --publish never \
  -c.mac.identity="$identity" -c.mac.notarize=true -c.dmg.sign=true
codesign --verify --strict "$dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"

check_team
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"
spctl --assess --type execute "$app"
say "built $dmg (Developer ID signed, notarized, stapled)"
