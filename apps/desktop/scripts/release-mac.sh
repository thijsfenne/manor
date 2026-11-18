#!/bin/bash
# Builds the release DMG of Manor.app for Apple Silicon into apps/desktop/release/.
# Run from the repo root via `pnpm desktop:release`. It never touches /Applications.
#
#   MANOR_SIGN_IDENTITY   a "Developer ID Application" identity in your keychain: its SHA-1
#                         hash, or its name without that prefix (`security find-identity -v -p codesigning`)
#   MANOR_NOTARY_PROFILE  a notarytool keychain profile (`xcrun notarytool store-credentials`)
#
# With both set, the app is signed with the hardened runtime, notarized and stapled,
# and the DMG is signed, notarized and stapled too. Otherwise the app inside the DMG
# is ad hoc signed, as `pnpm desktop:package` does: fine on the Mac that built it, not
# something to hand out.
set -euo pipefail

cd "$(dirname "$0")/.."
version="$(node -p "require('./package.json').version")"
app="release/mac-arm64/Manor.app"
dmg="release/Manor-$version-arm64.dmg"
identity="${MANOR_SIGN_IDENTITY:-}"
profile="${MANOR_NOTARY_PROFILE:-}"

say() { printf '[release] %s\n' "$*"; }

pnpm bundle:app
pnpm build
rm -f "$dmg"

missing=()
[ -n "$identity" ] || missing+=(MANOR_SIGN_IDENTITY)
[ -n "$profile" ] || missing+=(MANOR_NOTARY_PROFILE)
if [ "${#missing[@]}" -gt 0 ]; then
  say "not set: ${missing[*]}. Building a DMG with an ad hoc signed app, not notarized."
  # build.mac.identity is null, so electron-builder neither signs nor notarizes.
  pnpm exec electron-builder --mac dir --arm64 --publish never
  pnpm sign:mac
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

codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
xcrun stapler validate "$dmg"
spctl --assess --type execute "$app"
say "built $dmg (Developer ID signed, notarized, stapled)"
