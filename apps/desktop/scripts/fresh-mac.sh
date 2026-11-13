#!/bin/bash
# Runs a second, empty Manor beside the one you use, to try a change or to see what a
# new user sees. Run from the repo root via `pnpm desktop:fresh`.
#
#   pnpm desktop:fresh              an empty workspace, with the provider CLIs you already signed in to
#   pnpm desktop:fresh --stranger   also an empty home folder: no provider is installed or signed in
#   pnpm desktop:fresh --reset      empty it first (with either of the above)
#   pnpm desktop:fresh --build      package the current tree first, instead of using the last build
#
# `--build` rebuilds `apps/web/dist`. A server that serves that folder from this
# checkout answers with the new build afterwards, as it does after `desktop:install`.
#
# Everything it writes is under ~/.manor-fresh: the database, memory, the desktop
# profile and the logs. It reads nothing from ~/.manor or from apps/server/.env, and
# your own Manor keeps running untouched. Quit the window, or press Ctrl+C, to stop it.
#
# One thing is shared on purpose in the default mode: the provider CLIs keep their
# sign-in under your home folder, so a turn here spends your real subscription.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
root="${MANOR_FRESH_DIR:-$HOME/.manor-fresh}"
port="${MANOR_FRESH_PORT:-43190}"
stranger=0; reset=0; build=0
for arg in "$@"; do
  case "$arg" in
    --stranger) stranger=1 ;;
    --reset) reset=1 ;;
    --build) build=1 ;;
    *) echo "desktop:fresh: unknown option $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[2m[fresh]\033[0m %s\n' "$*"; }

if [ "$build" = 1 ]; then (cd "$repo" && pnpm desktop:package); fi
app="$repo/apps/desktop/release/mac-arm64/Manor.app"
[ -d "$app" ] || app="/Applications/Manor.app"
binary="$app/Contents/MacOS/Manor"
entry="$app/Contents/Resources/server/dist/main.mjs"
if [ ! -x "$binary" ] || [ ! -f "$entry" ]; then
  echo "desktop:fresh: no packaged Manor found. Build one with: pnpm desktop:fresh --build" >&2
  exit 1
fi

if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "desktop:fresh: port $port is taken, probably by a fresh Manor that is still open. Quit it, or set MANOR_FRESH_PORT." >&2
  exit 1
fi

# The folder is this script's own or it is not used at all. The mark is only ever
# written into a folder the script made or found empty, so a `MANOR_FRESH_DIR` that
# points at something else (your real `~/.manor`, say) can never be marked and then
# emptied by a later `--reset`.
if [ -e "$root" ] && [ ! -f "$root/.manor-fresh" ] && [ -n "$(ls -A "$root" 2>/dev/null)" ]; then
  echo "desktop:fresh: $root exists and was not made by this script, so it is left alone. Pick another folder with MANOR_FRESH_DIR." >&2
  exit 1
fi
if [ "$reset" = 1 ] && [ -f "$root/.manor-fresh" ]; then
  say "emptying $root"
  rm -rf "$root"
fi
mkdir -p "$root/data" "$root/desktop" "$root/logs"
: > "$root/.manor-fresh"

# A clean environment, so no setting from your shell or your own Manor reaches this one.
home="$HOME"; path="$PATH"
if [ "$stranger" = 1 ]; then
  home="$root/home"
  mkdir -p "$home"
  # A Mac that never had a provider CLI: the system folders, and where an installer would put one.
  path="$home/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
fi
base=(HOME="$home" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/zsh}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" PATH="$path" MANOR_DATA_DIR="$root/data")

say "starting the server from $app"
env -i "${base[@]}" ELECTRON_RUN_AS_NODE=1 MANOR_HOST=127.0.0.1 MANOR_PORT="$port" \
  MANOR_WEB_DIST="$app/Contents/Resources/web" \
  "$binary" "$entry" >>"$root/logs/manor.log" 2>>"$root/logs/manor.err.log" &
server=$!
stop() { kill "$server" 2>/dev/null || true; }
trap stop EXIT

for _ in $(seq 1 150); do
  if ! kill -0 "$server" 2>/dev/null; then
    echo "desktop:fresh: the server stopped while starting. Last lines of its log:" >&2
    tail -15 "$root/logs/manor.err.log" >&2 || true
    exit 1
  fi
  curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null && break
  sleep 0.2
done
if ! curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then
  echo "desktop:fresh: the server did not answer on $port. See $root/logs/manor.err.log" >&2
  exit 1
fi

say "up on $port, data in $root$([ "$stranger" = 1 ] && echo ', with an empty home folder')"
say 'opening the window. Quit it to stop this Manor.'
# The window keeps your real home folder, which macOS needs; the profile folder keeps
# its browser data, saved logins and window state apart from your own Manor.
env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" PATH="$PATH" \
  MANOR_DATA_DIR="$root/data" MANOR_DESKTOP_URL="http://localhost:$port/" \
  "$binary" --user-data-dir="$root/desktop" >>"$root/logs/desktop.log" 2>&1 || true
say 'stopped.'
