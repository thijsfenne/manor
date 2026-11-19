#!/bin/bash
# Builds Manor.app and swaps it into /Applications. Run from the repo root via
# `pnpm desktop:install`. A failed build leaves the installed app untouched.
# Safe to start from a Manor chat: the turn runs in the LaunchAgent server, not
# in the app this script quits.
set -euo pipefail

# Replaces $2 with a copy of $1. The old bundle is moved aside, not deleted, until
# the new one is in place, so a failed step never leaves /Applications without Manor.
swap_app() {
  local built="$1" target="$2"
  local staged="$target.installing" previous="$target.previous"
  # An interrupted earlier run can leave only the moved-aside copy.
  if [ ! -e "$target" ] && [ -e "$previous" ]; then mv "$previous" "$target"; fi
  rm -rf "$staged" "$previous"
  ditto "$built" "$staged"
  if [ -e "$target" ]; then mv "$target" "$previous"; fi
  if ! mv "$staged" "$target"; then
    if [ -e "$previous" ]; then mv "$previous" "$target"; fi
    rm -rf "$staged"
    echo "desktop:install: could not place the new app, $target was restored." >&2
    return 1
  fi
  rm -rf "$previous"
}

# Sourcing the script only defines swap_app, for checking the swap by hand.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
built="$repo/apps/desktop/release/mac-arm64/Manor.app"
target="/Applications/Manor.app"
binary="$target/Contents/MacOS/Manor"

cd "$repo"
# macOS ties Accessibility and Screen Recording to the app's signature. An ad hoc build
# never matches an earlier grant, so with a Developer ID in the keychain every install
# is signed with it and the grants stay. `security` prints `1) <SHA-1> "<name>"`.
identity="${MANOR_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk '/"Developer ID Application:/ { print $2; exit }')}"
if ! MANOR_SIGN_IDENTITY="$identity" bash apps/desktop/scripts/release-mac.sh --app; then
  echo "desktop:install: build failed, $target was not touched." >&2
  exit 1
fi

# A restart keeps the old binary in memory, so the running app must fully exit
# before the bundle is replaced.
if pgrep -f "$binary" >/dev/null; then
  osascript -e 'quit app id "com.thijsfenne.manor"' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    pgrep -f "$binary" >/dev/null || break
    sleep 0.5
  done
  if pgrep -f "$binary" >/dev/null; then
    echo "desktop:install: Manor did not quit within 20s, $target was not replaced. If it asks whether to quit while agents work, answer it and run this again." >&2
    exit 1
  fi
fi

swap_app "$built" "$target"

open "$target"
echo "desktop:install: installed and opened $target."
