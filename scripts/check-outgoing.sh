#!/bin/bash
# Fails when a commit about to be pushed carries a private mail address as author or
# committer, or a private name in its message. A pushed commit is public for good.
#
# The push hook runs this with the remote's name as argument and git's list of pushed
# refs on stdin. The names are the same ones `scripts/check-public.sh` reads, from
# `$MANOR_PRIVATE_NAMES_FILE` or `~/.config/manor/private-names`. Without that file
# there is nothing to judge and the check passes.
#
# GitHub's noreply addresses are fine and are skipped. Commit under one with
# `git config user.email <id>+<login>@users.noreply.github.com`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

remote="${1:-origin}"
names_file="${MANOR_PRIVATE_NAMES_FILE:-$HOME/.config/manor/private-names}"
[ -r "$names_file" ] || exit 0
private="$(head -n 1 "$names_file")"
[ -n "$private" ] || exit 0

# The app id and the repository address carry the publisher's name by design.
publisher='com\.thijsfenne\.manor[a-z-]*|github\.com/thijsfenne/[A-Za-z-]+'

failed=0
while read -r _ local_oid _ remote_oid; do
  # A deleted ref pushes no commits.
  if [[ "$local_oid" =~ ^0+$ ]]; then continue; fi
  if [[ "$remote_oid" =~ ^0+$ ]]; then
    range=("$local_oid" --not "--remotes=$remote")
  else
    range=("$remote_oid..$local_oid")
  fi

  addresses="$(git log --format='%h %ae%n%h %ce' "${range[@]}" | sort -u \
    | { grep -v '@users\.noreply\.github\.com$' || true; } \
    | { grep -E -i "$private" || true; })"
  if [ -n "$addresses" ]; then
    echo "check-outgoing: these commits carry a private mail address:" >&2
    echo "$addresses" | cut -d' ' -f1 | sort -u >&2
    failed=1
  fi

  for commit in $(git log --format=%h "${range[@]}"); do
    if git show -s --format=%B "$commit" | sed -E "s#($publisher)##g" | grep -q -E -i "$private"; then
      echo "check-outgoing: the message of $commit holds a private name" >&2
      failed=1
    fi
  done
done

if [ "$failed" -ne 0 ]; then
  echo "check-outgoing: rewrite these commits before you push, nothing was sent" >&2
  exit 1
fi
echo "check-outgoing: ok"
