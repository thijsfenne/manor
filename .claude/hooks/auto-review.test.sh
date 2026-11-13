#!/usr/bin/env bash
set -euo pipefail

source_root="$(git rev-parse --show-toplevel)"
fixture_root="$(mktemp -d)"
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p "$fixture_root/.claude/hooks" "$fixture_root/apps/server/src" "$fixture_root/docs"
cp "$source_root/.claude/hooks/auto-review.sh" "$fixture_root/.claude/hooks/"
cp "$source_root/.claude/hooks/capture-review-turn.sh" "$fixture_root/.claude/hooks/"
cp "$source_root/.claude/hooks/review-signal.sh" "$fixture_root/.claude/hooks/"
cp "$source_root/.claude/hooks/review-turn-state.sh" "$fixture_root/.claude/hooks/"

git -C "$fixture_root" init -q -b main
git -C "$fixture_root" config user.name "Manor Hook Test"
git -C "$fixture_root" config user.email "hook-test@manor.local"
printf 'export const base = true;\n' > "$fixture_root/apps/server/src/example.ts"
git -C "$fixture_root" add .
git -C "$fixture_root" commit -qm "Initial fixture"

# Simulate substantial app-code changes that already existed when the agent
# session started. They must not wake a review after a conversational turn.
awk 'BEGIN { for (i = 1; i <= 40; i++) print "export const old" i " = " i ";" }' \
  >> "$fixture_root/apps/server/src/example.ts"

session_input='{"session_id":"test-session","stop_hook_active":false}'
active_input='{"session_id":"test-session","stop_hook_active":true}'

printf '%s' "$session_input" | (cd "$fixture_root" && .claude/hooks/capture-review-turn.sh)
quiet_output="$(printf '%s' "$session_input" | (cd "$fixture_root" && .claude/hooks/auto-review.sh))"
[ -z "$quiet_output" ] || {
  printf 'Expected an unchanged conversational turn to stay quiet.\n' >&2
  exit 1
}

# A real code turn changes the per-session signal and still reaches the normal
# branch-wide threshold and review prompt.
awk 'BEGIN { for (i = 1; i <= 35; i++) print "export const current" i " = " i ";" }' \
  >> "$fixture_root/apps/server/src/example.ts"
review_output="$(printf '%s' "$session_input" | (cd "$fixture_root" && .claude/hooks/auto-review.sh))"
printf '%s' "$review_output" | grep -q '"decision":"block"' || {
  printf 'Expected a code-changing turn to trigger review.\n' >&2
  exit 1
}

# The continuation advances the turn baseline, so the next conversational turn
# cannot retrigger for reviewer changes or for the same diff.
printf 'export const reviewerFix = true;\n' >> "$fixture_root/apps/server/src/example.ts"
continuation_output="$(printf '%s' "$active_input" | (cd "$fixture_root" && .claude/hooks/auto-review.sh))"
[ -z "$continuation_output" ] || {
  printf 'Expected the review continuation to stay quiet.\n' >&2
  exit 1
}
next_output="$(printf '%s' "$session_input" | (cd "$fixture_root" && .claude/hooks/auto-review.sh))"
[ -z "$next_output" ] || {
  printf 'Expected the turn after a continuation to stay quiet.\n' >&2
  exit 1
}

# Non-reviewable files never alter the turn signal.
printf 'Conversation notes only.\n' > "$fixture_root/docs/note.md"
docs_output="$(printf '%s' "$session_input" | (cd "$fixture_root" && .claude/hooks/auto-review.sh))"
[ -z "$docs_output" ] || {
  printf 'Expected a docs-only turn to stay quiet.\n' >&2
  exit 1
}

printf 'auto-review turn gate tests passed\n'
