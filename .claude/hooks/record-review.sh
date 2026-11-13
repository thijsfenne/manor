#!/usr/bin/env bash
# Stamp the current diff as reviewed so the Stop hook (auto-review.sh) won't
# re-trigger on the same state. Run this as the final step after an auto-review.
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" || exit 0

. "$root/.claude/hooks/review-signal.sh"

# Skip the write when there's no diff: review_signal_hash returns empty, which
# would otherwise truncate the marker to 0 bytes. The line count is stamped
# alongside the hash so the size-debounce in auto-review.sh measures new work
# from this reviewed state, not from zero.
h="$(review_signal_hash)"
if [ -n "$h" ]; then
  printf '%s\n' "$h" > .claude/.last-review-hash
  review_signal_linecount > .claude/.last-review-count
  echo "Stamped .claude/.last-review-hash"
else
  echo "No diff to stamp; marker left unchanged"
fi
