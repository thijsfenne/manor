#!/usr/bin/env bash
# SessionStart hook: remember the existing branch diff so an unrelated first
# turn cannot wake the automatic reviewer for work from before this session.
set -euo pipefail

input="$(cat)"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

. "$root/.claude/hooks/review-signal.sh"
. "$root/.claude/hooks/review-turn-state.sh"

review_turn_capture "$input" || exit 0
