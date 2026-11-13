#!/bin/bash
# Fails when a tracked file holds a private name or a private path.
#
# This repository is public. A maintainer's private names (people, clients, home
# folders, other projects) do not belong in it. The push hook and CI run this check;
# run it by hand with `scripts/check-public.sh`.
#
# The names themselves are not in this file, since listing them here would publish
# them. They are one extended regular expression on the first line of a file on the
# maintainer's own machine: `$MANOR_PRIVATE_NAMES_FILE`, or
# `~/.config/manor/private-names`. Without that file only the stray file check runs.
#
# A hit is either a leak, which you remove, or a place where the publisher's name is
# meant to be, which you add to `allowed` below with a reason.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

names_file="${MANOR_PRIVATE_NAMES_FILE:-$HOME/.config/manor/private-names}"
private=""
if [ -r "$names_file" ]; then private="$(head -n 1 "$names_file")"; fi

# The app id, the labels built from it and the repository address carry the
# publisher's name by design, in any file. They are taken out of a line before it
# is judged.
publisher='com\.thijsfenne\.manor[a-z-]*|github\.com/thijsfenne/[A-Za-z-]+'

# Files where the publisher's name itself is meant to be: the licence, the author
# fields and the Expo owner.
allowed='^(LICENSE|scripts/check-public\.sh|apps/desktop/package\.json|apps/mobile/app\.json|apps/mobile/modules/manor-image-paste/ios/ManorImagePaste\.podspec):'

if [ -n "$private" ]; then
  hits="$(git ls-files -z -- . ':!pnpm-lock.yaml' | { xargs -0 grep -InE -i "$private" 2>/dev/null || true; })"
  judged="$(printf '%s\n' "$hits" | { grep -vE "$allowed" || true; } | sed -E "s#($publisher)##g")"
  leaks="$(printf '%s\n' "$judged" | { grep -E -i "^[^:]+:[0-9]+:.*($private)" || true; })"
  if [ -n "$leaks" ]; then
    echo "check-public: private names or paths in tracked files:" >&2
    echo "$leaks" | cut -c1-200 >&2
    exit 1
  fi
fi

# Files that must stay out: sign in state, local settings, a maintainer's notes.
stray="$(git ls-files | grep -E '(^|/)\.env$|\.local(\.|$)|^BRIEFING\.md$|^docs/(PRODUCT\.md|decisions|audits|portfolio-screenshots)|^\.mcp\.json$|(^|/)auth\.json$' || true)"
if [ -n "$stray" ]; then
  echo "check-public: these files must not be tracked:" >&2
  echo "$stray" >&2
  exit 1
fi
if [ -z "$private" ]; then
  echo "check-public: ok (stray files only, no private names file on this machine)"
else
  echo "check-public: ok"
fi
