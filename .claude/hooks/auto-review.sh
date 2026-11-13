#!/usr/bin/env bash
# Shared Claude Code and Codex Stop hook: auto-trigger a review over the diff
# after a turn that changed reviewable app code.
#
# Fires only for app-code changes, size-debounced, and never loops on its work:
#   - skips when the reviewable diff did not change during the current turn
#   - skips when already inside a stop-hook continuation (stop_hook_active)
#   - skips when there is no reviewable diff (config/plans/ideas/docs and *.md
#     are excluded from the signal in review-signal.sh — they never wake the
#     reviewer)
#   - skips when the diff is unchanged since the last recorded review
#   - skips until at least MIN_NEW_LINES changed lines have accumulated since
#     the last review, so small tweaks and tight iteration do not nag; a
#     genuinely new chunk of work (a later feature in a long session) still
#     re-triggers
#   - stamps the state it triggers on, so an abandoned turn can't re-trigger it
# When it does fire, it hands the orchestrator the diff and lets it pick the
# review depth itself (a quick inline pass for small/low-risk changes, or the
# full typecheck + tests + Manor Reviewer agent for substantial/risky ones).
#
# Requires: bash, git, node (the JSON encoder/parser; already on this machine),
# and sha256sum or shasum (via review-signal.sh).
set -euo pipefail

input="$(cat)"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

. "$root/.claude/hooks/review-signal.sh"
. "$root/.claude/hooks/review-turn-state.sh"

# Parse the loop guard with node rather than grepping the raw payload. If the
# payload can't be parsed, fail safe and emit no block.
active="$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).stop_hook_active===true?"1":"0")}catch{process.stdout.write("err")}})' 2>/dev/null)" || exit 0
[ "$active" != "err" ] || exit 0

# Gate the branch-wide review signal on this turn. SessionStart captures the
# initial state. Every Stop advances it, including the continuation after an
# automatic review, so old branch changes cannot wake a later conversational
# or read-only turn. Missing session identity also fails quiet.
turn_marker="$(review_turn_marker "$input")" || exit 0
turn_signal="$(review_turn_signal)"
if [ ! -f "$turn_marker" ]; then
  printf '%s\n' "$turn_signal" > "$turn_marker"
  exit 0
fi
previous_turn_signal="$(cat "$turn_marker" 2>/dev/null || true)"
printf '%s\n' "$turn_signal" > "$turn_marker"

# A stop-hook continuation may include reviewer fixes. Capture its final state
# above, then stop before the trigger logic to prevent recursive continuation.
[ "$active" = "0" ] || exit 0
[ "$turn_signal" != "$previous_turn_signal" ] || exit 0

# Minimum new changed lines (added or removed) since the last review before the
# trigger re-fires. Small tweaks below this stay quiet; tune here.
MIN_NEW_LINES=30

hash="$(review_signal_hash)"
[ -n "$hash" ] || exit 0   # empty diff -> nothing to review

marker=".claude/.last-review-hash"
if [ -f "$marker" ] && [ "$(cat "$marker")" = "$hash" ]; then
  exit 0
fi

# Size-debounce: stay quiet until enough NEW changed lines have piled up since
# the last review. Compares the current reviewable line count against the count
# stamped at the last review (0 if never reviewed). This suppresses small tweaks
# and tight per-turn iteration, while a later substantial chunk of work crosses
# the threshold and re-fires. Stamped at fire time below, so an abandoned turn
# advances the baseline and can't immediately re-trigger.
count_marker=".claude/.last-review-count"
current_lines="$(review_signal_linecount)"
prev_lines=0
if [ -f "$count_marker" ]; then
  prev_lines="$(cat "$count_marker" 2>/dev/null || echo 0)"
fi
case "$prev_lines" in ''|*[!0-9]*) prev_lines=0 ;; esac
# The baseline is a count of lines in the diff against the *merge-base*, and that
# base moves: a push or merge to origin/main folds reviewed work into the base
# and shrinks the diff. A stamped baseline from before that point measures a
# different scale, and since the difference goes deeply negative the trigger
# stays silent forever (observed 2026-08-10: a 10740-line baseline survived a
# push, muting the reviewer for every turn after it). A diff smaller than the
# baseline always means the scale shifted, never that new work appeared, so drop
# the stale baseline instead of comparing across it. The hash gate above is what
# guarantees correctness here — an unchanged diff never reaches this line — so
# resetting only costs a review on genuinely changed code.
if [ "$current_lines" -lt "$prev_lines" ]; then
  prev_lines=0
fi
if [ "$((current_lines - prev_lines))" -lt "$MIN_NEW_LINES" ]; then
  exit 0
fi

# `read -d ''` returns non-zero at EOF (no NUL terminator) by design, so the
# `|| true` keeps `set -e` from aborting while still capturing the heredoc.
read -r -d '' reason <<'EOF' || true
Auto-review: the branch has un-reviewed app-code changes (config, plans, ideas,
docs, the lockfile, and *.md are excluded, and small changes are debounced, so
this only fires once enough new app-code accumulates). Before ending your turn,
review the changes — but pick the depth yourself:

1. Look at the diff: `git diff "$(git merge-base origin/main HEAD)"` plus any
   untracked files. Judge the change's size and risk surface.
2. Choose the review depth:
   - Small / low-risk (a few lines, one dumb component, no logic touching
     drivers, orchestrator, store, contracts, auth, process execution, resource
     identity, HTTP/WebSocket trust, streaming hot paths, caches, deployment,
     or the memory layer): do a
     quick inline review — read the changed lines against the applicable project
     instructions and report briefly. Skip the typecheck sweep and the subagent;
     this does not need a full reviewer.
   - Substantial / risky (new logic, multiple files, or anything touching
     drivers/orchestrator/stores/contracts/auth/process execution/resource
     identity/HTTP or WebSocket trust/streaming hot paths/caches/deployment/
     memory-layer/turn-taking): run
     `pnpm -r typecheck` and the tests for the touched scope (e.g.
     `pnpm --filter @manor/server test`), then spawn the read-only
     configured "Manor Reviewer" agent with the results as context
     (.claude/agents/reviewer.md in Claude Code,
     .codex/agents/reviewer.toml in Codex).
3. Apply ONLY clear P0 and P1 findings. List any P2/P3 as a short proposal
   block for the maintainer — do not change that code.
4. If you changed code, re-run the typecheck to confirm it's clean.
5. Run `.claude/hooks/record-review.sh` as the final step to stamp the review.
Do not commit or push unless the user asked you to.
EOF

# decision:block feeds `reason` back to the agent so it continues with this
# work. Encode the reason as a JSON string with Node. Fail closed — emit no
# block rather than malformed JSON — if encoding fails.
encoded="$(printf '%s' "$reason" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))' 2>/dev/null)" || exit 0
[ -n "$encoded" ] || exit 0

# Stamp the state we're about to trigger on, so an abandoned turn (one that
# never reaches record-review.sh) can't re-trigger this same diff and the line
# baseline advances. After applying fixes the agent re-stamps the post-fix
# state via record-review.sh, which keeps the next turn from re-reviewing its
# own changes.
printf '%s\n' "$hash" > "$marker"
printf '%s\n' "$current_lines" > "$count_marker"

printf '{"decision":"block","reason":%s}\n' "$encoded"
exit 0
