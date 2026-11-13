#!/bin/sh
# Real Git and pnpm, no provider runtimes or shared-checkout mutations.
set -eu
source_root=$(git rev-parse --show-toplevel)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/manor-hook-test.XXXXXX")
trap 'rm -rf "$fixture"' 0
trap 'exit 1' 1 2 15
mkdir -p "$fixture/repo/apps/probe" "$fixture/repo/packages/shared"
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
EOF
pnpm install --offline --ignore-scripts > "$fixture/install.log" 2>&1
git add .
git -c core.hooksPath=/dev/null commit -qm baseline
mkdir .githooks
cp "$source_root/.githooks/pre-commit" .githooks/pre-commit
chmod +x .githooks/pre-commit
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
mkdir "$fixture/linked/.githooks"
cp .githooks/pre-commit "$fixture/linked/.githooks/pre-commit"
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
