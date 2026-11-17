#!/bin/sh
# Real Git and pnpm, no provider runtimes or shared-checkout mutations.
set -eu
source_root=$(git rev-parse --show-toplevel)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/manor-hook-test.XXXXXX")
trap 'rm -rf "$fixture"' 0
trap 'exit 1' 1 2 15
# The hook keeps its run folders under TMPDIR. A temp folder of its own keeps this
# test away from the hook runs of real commits on the same machine.
TMPDIR=$fixture/tmp
export TMPDIR
record=$fixture/record
mkdir -p "$TMPDIR" "$record" "$fixture/repo/apps/probe" "$fixture/repo/packages/shared"
install_hooks() {
  mkdir "$1/.githooks"
  cp "$source_root/.githooks/pre-commit" "$source_root/.githooks/lib.sh" "$1/.githooks/"
  chmod +x "$1/.githooks/pre-commit"
}
cd "$fixture/repo"
git init -q
git config user.name 'Manor hook test'
git config user.email 'hook-test@manor.local'
printf 'node_modules/\n' > .gitignore
printf '{"private":true,"packageManager":"pnpm@10.32.1"}\n' > package.json
printf 'packages:\n  - apps/*\n  - packages/*\n' > pnpm-workspace.yaml
cat > apps/probe/package.json <<'EOF'
{"name":"@hook/probe","private":true,"type":"module","scripts":{"test":"node test.mjs"},"dependencies":{"@hook/shared":"workspace:*"}}
EOF
cat > packages/shared/package.json <<'EOF'
{"name":"@hook/shared","private":true,"type":"module","exports":"./index.js"}
EOF
printf 'export default "good"\n' > packages/shared/index.js
printf 'export default 1\n' > apps/probe/own.js
cat > apps/probe/test.mjs <<'EOF'
import assert from 'node:assert/strict'
import value from '@hook/shared'
assert.equal(value, 'good', 'foreign package source must come from the commit index')
// With HOOK_TEST_RECORD set, the probe says it ran, leaves a temp folder behind the
// way a careless test does, notices another probe running beside it, and can be slow.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
const record = process.env.HOOK_TEST_RECORD
if (record) {
  fs.appendFileSync(`${record}/log`, `${process.pid} ${fs.mkdtempSync(nodePath.join(os.tmpdir(), 'leftover-'))}\n`)
  try { fs.mkdirSync(`${record}/running`) } catch { fs.writeFileSync(`${record}/overlap`, '') }
  await new Promise((done) => setTimeout(done, Number(process.env.HOOK_TEST_SLEEP ?? 0) * 1000))
  fs.rmSync(`${record}/running`, { recursive: true, force: true })
}
EOF
pnpm install --offline --ignore-scripts > "$fixture/install.log" 2>&1
git add .
git -c core.hooksPath=/dev/null commit -qm baseline
install_hooks .
git config core.hooksPath .githooks

# Old behavior tests foreign dirty source, although only own.js is being committed.
printf 'export default 2\n' > apps/probe/own.js
git add apps/probe/own.js
printf 'export default "broken"\n' > packages/shared/index.js
if pnpm --stream '--filter=...{./apps/probe}' test > "$fixture/old.log" 2>&1; then
  echo 'FAIL: old working-tree gate unexpectedly accepted broken foreign source' >&2
  exit 1
fi
grep -q 'foreign package source' "$fixture/old.log"
echo 'PASS: old gate rejects foreign dirty source outside the commit'

# --only must ignore even foreign STAGED source and leave it exactly as it was.
git add packages/shared/index.js
foreign_blob=$(git rev-parse :packages/shared/index.js)
git commit --only -qm 'Own content' -- apps/probe/own.js > "$fixture/new.log" 2>&1 || {
  cat "$fixture/new.log" >&2; exit 1;
}
test "$(git rev-parse :packages/shared/index.js)" = "$foreign_blob"
test "$(cat packages/shared/index.js)" = 'export default "broken"'
test "$(git show HEAD:packages/shared/index.js)" = 'export default "good"'
echo 'PASS: isolated gate accepts the same commit and preserves foreign staged work'

# The exact same break, when carried by the commit, must block it.
before=$(git rev-parse HEAD)
if git commit --only -qm 'Broken content' -- packages/shared/index.js > "$fixture/broken.log" 2>&1; then
  echo 'FAIL: isolated gate accepted broken committed content' >&2
  exit 1
fi
grep -q 'foreign package source' "$fixture/broken.log"
test "$(git rev-parse HEAD)" = "$before"
test "$(git rev-parse :packages/shared/index.js)" = "$foreign_blob"
echo 'PASS: isolated gate blocks broken committed content without changing HEAD or index'

# Linked worktrees hand hooks GIT_DIR. A test's git init must stay in its own temp.
git worktree add -q --detach "$fixture/linked" HEAD
install_hooks "$fixture/linked"
cd "$fixture/linked"
printf 'export default 3\n' > apps/probe/own.js
cat >> apps/probe/test.mjs <<'EOF'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const temp = mkdtempSync(join(tmpdir(), 'hook-git-init-'))
try { execFileSync('git', ['init', '-q'], { cwd: temp }) }
finally { rmSync(temp, { recursive: true, force: true }) }
EOF
git add apps/probe
git commit -qm 'Linked worktree' > "$fixture/linked.log" 2>&1 || {
  cat "$fixture/linked.log" >&2; exit 1;
}
test "$(git config --get core.bare)" = false
test "$(git -C "$fixture/repo" config --get core.bare)" = false
echo 'PASS: linked-worktree environment cannot leak into test repositories'

# Two Sessions commit in the same second. The second waits; the probes never overlap.
cd "$fixture/repo"
for name in first second slow; do
  git worktree add -q --detach "$fixture/$name" HEAD
  install_hooks "$fixture/$name"
  printf 'export default "%s"\n' "$name" > "$fixture/$name/apps/probe/own.js"
  git -C "$fixture/$name" add apps/probe/own.js
done
(cd "$fixture/first" && HOOK_TEST_RECORD=$record HOOK_TEST_SLEEP=3 git commit -qm First > "$fixture/first.log" 2>&1) &
first=$!
(cd "$fixture/second" && HOOK_TEST_RECORD=$record HOOK_TEST_SLEEP=3 git commit -qm Second > "$fixture/second.log" 2>&1) &
second=$!
wait "$first" && wait "$second" || { cat "$fixture/first.log" "$fixture/second.log" >&2; exit 1; }
test "$(wc -l < "$record/log")" -eq 2
test ! -e "$record/overlap"
cat "$fixture/first.log" "$fixture/second.log" | grep -q 'waiting for another hook run'
echo 'PASS: two commits at once run their tests one after the other'

# What a test leaves in the temp folder goes with the run, and so does the run folder.
while read -r _ leftover; do test ! -e "$leftover"; done < "$record/log"
test -z "$(ls "$TMPDIR/manor-hooks")"
echo 'PASS: a finished run leaves nothing in the temp folder'

# The installed node_modules wait in the shared git folder for the next run, of any
# worktree, with no file of a commit beside them. That run takes them into its snapshot
# and hands them back: a mark left in them returns, in a kept folder made anew.
kept=$fixture/repo/.git/manor-hook-modules
test -d "$kept/node_modules"
test -z "$(find "$kept" -name node_modules -prune -o -type f -print)"
: > "$kept/apps/probe/node_modules/mark"
kept_before=$(ls -di "$kept")
printf 'export default "again"\n' > "$fixture/first/apps/probe/own.js"
git -C "$fixture/first" commit -qam Again > "$fixture/again.log" 2>&1 || { cat "$fixture/again.log" >&2; exit 1; }
test -e "$kept/apps/probe/node_modules/mark"
test "$(ls -di "$kept")" != "$kept_before"
echo 'PASS: the next run reuses the installed node_modules'

# A file a commit tracks under node_modules would stay with the kept ones, for a later
# snapshot to read. Such a commit installs afresh and leaves the kept ones as they were.
kept_before=$(ls -di "$kept")
mkdir -p "$fixture/first/apps/probe/node_modules"
printf 'export default "tracked"\n' > "$fixture/first/apps/probe/node_modules/tracked.js"
git -C "$fixture/first" add -f apps/probe/node_modules/tracked.js
git -C "$fixture/first" commit -qm Tracked > "$fixture/tracked.log" 2>&1 || { cat "$fixture/tracked.log" >&2; exit 1; }
test "$(ls -di "$kept")" = "$kept_before"
test -z "$(find "$kept" -name tracked.js)"
echo 'PASS: a commit that tracks a file under node_modules shares none with other runs'

# A run that is stopped halfway takes its tests and its folder with it, whether the
# hook is asked to stop, the hook is killed outright, or git itself goes away.
gone() {
  tries=0
  while kill -0 "$test_pid" 2>/dev/null || test -n "$(ls "$TMPDIR/manor-hooks")"; do
    tries=$((tries + 1))
    test "$tries" -lt 40 || { echo "FAIL: $1 left a test or a run folder behind" >&2; exit 1; }
    sleep 0.5
  done
}
for stop in 'TERM hook' 'KILL hook' 'TERM git'; do
  : > "$record/log"
  (cd "$fixture/slow" && exec env HOOK_TEST_RECORD="$record" HOOK_TEST_SLEEP=120 git commit -qm Slow > "$fixture/slow.log" 2>&1) &
  git_pid=$!
  tries=0
  until test -s "$record/log"; do
    tries=$((tries + 1))
    test "$tries" -lt 120 || { cat "$fixture/slow.log" >&2; exit 1; }
    sleep 0.5
  done
  test_pid=$(cut -d' ' -f1 "$record/log")
  hook_pid=$(cat "$TMPDIR"/manor-hooks/pre-commit.*/pid)
  case $stop in
    *hook) kill "-${stop% *}" "$hook_pid" ;;
    *git) kill "-${stop% *}" "$git_pid" ;;
  esac
  if wait "$git_pid"; then echo "FAIL: the commit went through although $stop stopped its tests" >&2; exit 1; fi
  gone "$stop"
  # A stopped hook had the kept node_modules in its run folder, and they went with it.
  case $stop in *hook) test ! -e "$kept" ;; esac
  rmdir "$record/running"
done
echo 'PASS: a stopped run stops its tests and removes its run folder'

# A run folder nobody could clean up names a pid that is gone. The next run removes it,
# and leaves the folder of a run that is still alive.
mkdir "$TMPDIR/manor-hooks/pre-commit.dead" "$TMPDIR/manor-hooks/pre-commit.alive"
echo "$test_pid" > "$TMPDIR/manor-hooks/pre-commit.dead/pid"
echo $$ > "$TMPDIR/manor-hooks/pre-commit.alive/pid"
git -C "$fixture/slow" commit -qm Slow > "$fixture/slow.log" 2>&1 || { cat "$fixture/slow.log" >&2; exit 1; }
test ! -e "$TMPDIR/manor-hooks/pre-commit.dead"
test -d "$TMPDIR/manor-hooks/pre-commit.alive"
echo 'PASS: the next run removes the folder of a run that was killed'
