#!/usr/bin/env bash
# Shared helpers for tying the automatic review trigger to one agent session.
# The marker stores the reviewable diff hash seen at the previous turn boundary.

review_turn_marker() {
  local input="$1" session_key digest

  session_key="$(printf '%s' "$input" | node -e '
    let source = "";
    process.stdin.on("data", (chunk) => { source += chunk; });
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(source);
        const key = payload.session_id
          ?? payload.conversation_id
          ?? payload.thread_id
          ?? payload.transcript_path;
        if (typeof key === "string") process.stdout.write(key);
      } catch {}
    });
  ' 2>/dev/null)" || return 1
  [ -n "$session_key" ] || return 1

  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(printf '%s' "$session_key" | sha256sum | cut -d' ' -f1)"
  else
    digest="$(printf '%s' "$session_key" | shasum -a 256 | cut -d' ' -f1)"
  fi
  printf '.claude/.last-review-turn-%s\n' "$digest"
}

review_turn_signal() {
  local hash
  hash="$(review_signal_hash)"
  if [ -n "$hash" ]; then
    printf '%s\n' "$hash"
  else
    printf '__empty__\n'
  fi
}

review_turn_capture() {
  local input="$1" marker signal
  marker="$(review_turn_marker "$input")" || return 1
  signal="$(review_turn_signal)"
  printf '%s\n' "$signal" > "$marker"
}
