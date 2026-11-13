#!/usr/bin/env bash
# PostToolUse hook: warn when hardcoded hex / rgba colors are introduced into
# .ts/.tsx files. Design tokens live in apps/web/src/styles.css (@theme) and
# flow through Tailwind classes and the per-persona --accent variable.
# Only checks the new content from the edit, not pre-existing patterns.
#
# Exempt files — persona colours are runtime DATA, not design tokens. A persona
# wears a hex the user picked; there is nothing to put in styles.css for it:
#   - apps/web/src/persona.ts        seed palette + safeHex fallback
#   - apps/web/src/projectAppearance.ts  the palette a project picks its colour from
#   - apps/web/src/state.ts          UNKNOWN_ACCENT fallback for unknown senders
#   - components/PersonaDialog.tsx   colour field placeholder / swatch
#   - components/ProviderMark.tsx    provider brand colours (Claude coral)
#   - components/AppMarks.tsx        Open in app logos and repo host logos
#   - apps/server/src/agents.ts      seed roster colours
#   - apps/web/test/*.test.ts(x)     roster fixtures, and the assertions on them
#   - apps/desktop/src/browserHost.ts  Electron native view background; a chrome
#                                    surface outside the DOM cannot read a CSS token
#   - apps/mobile/src/theme.ts       the native app's own token file (no CSS there)

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
new=$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // empty')

[ -z "$file" ] && exit 0
[ -z "$new" ] && exit 0

case "$file" in
  */apps/web/src/persona.ts) exit 0 ;;
  */apps/web/src/projectAppearance.ts) exit 0 ;;
  */apps/web/src/state.ts) exit 0 ;;
  */components/PersonaDialog.tsx) exit 0 ;;
  */components/ProviderMark.tsx) exit 0 ;;
  */components/AppMarks.tsx) exit 0 ;;
  */apps/server/src/agents.ts) exit 0 ;;
  */apps/desktop/src/browserHost.ts) exit 0 ;;
  */apps/mobile/src/theme.ts) exit 0 ;;
  */apps/web/test/*.test.ts|*/apps/web/test/*.test.tsx) exit 0 ;;
  *.tsx|*.ts|*.jsx|*.js) ;;
  *) exit 0 ;;
esac

hex=$(printf '%s\n' "$new" | grep -nE "['\"]#[0-9a-fA-F]{3,8}['\"]" || true)
rgb=$(printf '%s\n' "$new" | grep -nE "rgba?\s*\(" || true)

if [ -n "$hex" ] || [ -n "$rgb" ]; then
  {
    echo "Hardcoded color introduced in $file."
    echo "Use the @theme tokens in apps/web/src/styles.css (Tailwind classes) or the --accent variable."
    echo "Persona colours are data and belong in the exempt files listed in this hook."
    [ -n "$hex" ] && echo "$hex"
    [ -n "$rgb" ] && echo "$rgb"
  } >&2
  exit 2
fi

exit 0
