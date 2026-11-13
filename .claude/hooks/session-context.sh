#!/usr/bin/env bash
# SessionStart hook: surface the 5 most recently modified plans and ideas so
# Claude knows what's currently in flight without listing the full archive.

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

show_recent() {
  local dir=$1
  local label=$2
  [ ! -d "$dir" ] && return
  local files
  files=$(ls -t "$dir"/*.md 2>/dev/null | head -5)
  [ -z "$files" ] && return
  echo "=== $label ==="
  while IFS= read -r f; do
    mtime=$(stat -f "%Sm" -t "%b %d" "$f" 2>/dev/null || echo "")
    printf "  %s  (%s)\n" "$(basename "$f")" "$mtime"
  done <<< "$files"
  echo
}

show_recent ".claude/plans" "Recent plans (top 5 by mtime)"
show_recent ".claude/ideas" "Recent ideas (top 5 by mtime)"

plans_total=$(ls .claude/plans/*.md 2>/dev/null | wc -l | tr -d ' ')
ideas_total=$(ls .claude/ideas/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "Archive size: $plans_total plans, $ideas_total ideas total."
