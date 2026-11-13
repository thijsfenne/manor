#!/bin/bash
# Restarts the stable Manor server with the shortest offline window the work allows.
# Everything that can fail or take time happens while the old server still serves, so
# a tree that does not install or build never takes Manor down, and the launch agent
# never ends up restarting a failing build every ten seconds.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo"
plist="$HOME/Library/LaunchAgents/com.thijsfenne.manor.plist"
# The agent serves 43179, set inline by `stable:serve`; an inherited MANOR_PORT would
# only make this script wait on a port nothing serves.
port=43179
health="http://127.0.0.1:${port}/health"
# Enough for a cold start that migrates the database; a wedged start is reported, not waited out.
timeout=120

say() { printf '\033[2m[stable]\033[0m %s\n' "$*"; }

if [ ! -f "$plist" ]; then
  say "no launch agent at ${plist}. Install it with: pnpm stable:install"
  exit 1
fi

# A tree whose node_modules predate the current lockfile builds against the wrong
# packages, which is how a restart used to fail inside the agent where nobody saw it.
say 'installing workspace dependencies'
pnpm install --silent

# Into a staging directory, because the running server serves apps/web/dist and Vite
# empties its outDir first: building straight into it would leave that server answering
# 404 for a hashed chunk for the length of the build. Called as `vite build` rather than
# the package script so the staging outDir cannot be lost to argument forwarding.
say 'building the web app while the running server keeps serving'
rm -rf apps/web/dist.next apps/web/dist.old
pnpm --filter @manor/web exec vite build --outDir dist.next --emptyOutDir >/dev/null
if [ -d apps/web/dist ]; then mv apps/web/dist apps/web/dist.old; fi
mv apps/web/dist.next apps/web/dist
rm -rf apps/web/dist.old

# Whoever holds the port now also holds the database claim. Taken before the bootout,
# because `tsx src/main.ts` cannot tell this process from a verify spike on 43180 or a
# `pnpm dev` server, which run the very same command line.
owner="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
alive() { [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; }

offline=$SECONDS
say 'stopping the server'
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true

# Shutdown closes the HTTP server before it exits, so the claim outlives the port by up
# to a second and a half. Bootstrapping into a process that still holds it fails the
# start, and the agent then waits out its throttle, which is most of a slow restart.
waited=0
while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || alive; do
  if [ "$waited" -ge 40 ]; then
    say 'the old server did not exit; ending it'
    { [ -n "$owner" ] && kill -9 "$owner" 2>/dev/null; } || true
    sleep 1
    break
  fi
  sleep 0.25
  waited=$((waited + 1))
done

say 'starting the server'
# launchd can refuse a bootstrap that lands on the heels of a bootout. Failing here
# leaves Manor down, so say what brings it back rather than exiting bare.
if ! launchctl bootstrap "gui/$(id -u)" "$plist"; then
  sleep 1
  if ! launchctl bootstrap "gui/$(id -u)" "$plist"; then
    say 'the agent did not load and Manor is down. Bring it back with: pnpm stable:start'
    exit 1
  fi
fi

deadline=$(( $(date +%s) + timeout ))
until curl -fsS -m 2 -o /dev/null "$health" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "the server did not answer ${health} within ${timeout}s. Last lines of its log:"
    tail -20 "$HOME/Library/Logs/manor.err.log" || true
    exit 1
  fi
  sleep 0.25
done

say "up on ${port}, offline for $((SECONDS - offline))s"
