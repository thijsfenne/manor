#!/usr/bin/env bash
# Shared helpers: derive the current reviewable diff and summarize it.
# Sourced by auto-review.sh (to detect un-reviewed work) and record-review.sh
# (to stamp a completed review). One definition keeps the two in sync.

# Non-reviewable paths: the Manor Reviewer only reviews app code, so changes
# here must not count toward the trigger signal. Editing the reviewer config,
# plans, ideas, docs, or the lockfile should never wake the reviewer. Kept as a
# shared constant so the trigger and the stamp exclude the exact same paths.
REVIEW_EXCLUDE_PATHSPEC=(':!.claude' ':!.codex' ':!docs' ':!pnpm-lock.yaml' ':(exclude,glob)**/*.md')

# Raw reviewable diff: tracked changes vs the branch point plus untracked file
# contents, with the non-reviewable paths excluded. Shared base for both the
# hash and the line count below so they always describe the same change set.
review_signal_raw() {
  local base="" diff untracked untracked_blob=""

  # Anchor on the branch point (merge-base) so the signal stays stable when a
  # `git fetch` advances origin/main; diffing the working tree against that base
  # also captures uncommitted tracked changes, not just committed ones. (A plain
  # three-dot `origin/main...HEAD` would drop uncommitted work entirely.)
  if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    base="$(git merge-base origin/main HEAD 2>/dev/null)" || base=""
  fi
  if [ -n "$base" ]; then
    diff="$(git diff "$base" -- . "${REVIEW_EXCLUDE_PATHSPEC[@]}" 2>/dev/null)"
  else
    diff="$(git diff HEAD -- . "${REVIEW_EXCLUDE_PATHSPEC[@]}" 2>/dev/null)"
  fi

  # Include untracked file *contents*, not just their names — otherwise a brand
  # new file's edits dedupe against an identical name list and never re-trigger.
  untracked="$(git ls-files --others --exclude-standard -- . "${REVIEW_EXCLUDE_PATHSPEC[@]}" 2>/dev/null)"
  if [ -n "$untracked" ]; then
    untracked_blob="$(printf '%s\n' "$untracked" | while IFS= read -r f; do
      git diff --no-index --no-color /dev/null "$f" 2>/dev/null || true
    done)"
  fi

  printf '%s%s' "$diff" "$untracked_blob"
}

# Stable hash of the reviewable diff. Empty output (return 0) when there is
# nothing to review, which callers treat as "stay quiet".
review_signal_hash() {
  local signal
  signal="$(review_signal_raw)"
  [ -n "$signal" ] || return 0

  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$signal" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "$signal" | shasum -a 256 | cut -d' ' -f1
  fi
}

# Count of changed lines (added or removed) in the reviewable diff, ignoring the
# +++/--- file headers. Drives the size-debounce: the trigger only re-fires once
# enough new changed lines accumulate beyond the last reviewed count. awk always
# exits 0 and prints 0 on no match, so this is pipefail-safe.
review_signal_linecount() {
  review_signal_raw | awk '/^(\+\+\+|---)/ { next } /^[+-]/ { c++ } END { print c + 0 }'
}
