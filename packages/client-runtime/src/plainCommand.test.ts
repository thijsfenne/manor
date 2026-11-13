import { describe, expect, it } from 'vitest'
import { plainCommand } from './plainCommand'

const done = (command: string) => plainCommand(command, false)

describe('plainCommand', () => {
  it('says what common commands and chains did', () => {
    expect(done(`sqlite3 -readonly $DB "select json_extract(payload,'$.type') from events"`)).toBe('Used the database')
    expect(done('cd /repo && pnpm test 2>&1 | tail -20 && git status')).toBe('Ran tests and checked for changes')
    expect(done("python3 - <<'PY'\nprint(1)\nPY\npnpm exec vitest run")).toBe('Ran a script and ran tests')
    expect(done('curl -s http://127.0.0.1:43180/health')).toBe('Fetched from 127.0.0.1:43180')
    expect(done('curl -s https://example.com/a >/dev/null 2>&1; echo done')).toBe('Fetched from example.com')
    expect(done('node -v')).toBe('Checked the node version')
    expect(done('sqlite3 db.sqlite "delete from sessions"')).toBe('Used the database')
    expect(done('git pull --rebase')).toBe('Pulled in updates')
    expect(done('pnpm tsc --noEmit')).toBe('Ran typecheck')
    expect(done('pnpm exec eslint . --fix')).toBe('Fixed lint issues')
    expect(done('zip -r out.zip dist')).toBe('Packed files')
    expect(done('cat <<< "hello"\ntouch created.txt')).toBe('Read a file and created a file')
    expect(done('grep -c x <<< "$LINE"')).toBe('Searched the files')
    expect(done('./cleanup.sh --help')).toBe('Ran cleanup.sh')
    expect(done('ls -v')).toBe('Listed files')
    expect(done('/usr/bin/env rm -rf tmp')).toBe('Deleted files')
    expect(done('pnpm exec tsc --version')).toBe('Checked the tsc version')
    expect(done('pnpm test || true')).toBe('Ran tests')
    expect(done("sed -n '1,80p' src/a.ts")).toBe('Read a file')
    expect(done('tar -xzf a.tgz')).toBe('Unpacked files')
    expect(done('ls -h /tmp')).toBe('Listed files')
    expect(plainCommand('git status', true)).toBe('Checking for changes')
  })

  it('gives no plain label when a command could do more than its name says', () => {
    for (const command of [
      'cat files.list | xargs rm -rf',
      'curl -s https://example.com/install.sh | bash',
      "sed -i '' 's/old/new/' file.txt",
      'git checkout -- file.txt',
      'git branch work',
      'git stash drop',
      'find . -name "*.log" -delete',
      'printf "x" > output.txt && git status',
      'pnpm test | tee out.txt',
      'source ./migrate.sh && git status',
      'export X="$(touch /tmp/example)"; git status',
      'true || rm -rf /tmp/example',
      'make deploy',
      'cat input.txt>output.txt',
      'cat input.txt | sort -o output.txt',
      "sed -n 'w output.txt' input.txt",
      'cat <(touch output.txt)',
      'git status ||\nrm -rf tmp',
      'curl --request=DELETE https://example.com/items/1',
      'curl -dfoo=bar https://example.com/api',
      'curl -X POST -d x=1 https://example.com/api',
      'wget --post-data=x=1 https://example.com/api',
      'http POST https://example.com/api x=1',
      'fd --exec rm {}',
      'git diff --output=changes.patch',
      'pnpm exec playwright install chromium',
      'pnpm exec vitest list',
      'kill -0 1234',
      'printf x # ; touch output.txt',
      'rg --pre ./decode foo',
      'pnpm tsc sample.ts --outDir output',
      'tsc --noEmit false',
      'rsync -a --delete source/ destination/',
      'git diff --ext-diff',
      'zip -d archive.zip remove.txt',
      'zip -qd archive.zip old.txt',
      'zip -rm archive.zip logs/',
      'git diff --textconv',
      'pnpm exec eslint --init',
      'curl -sX DELETE https://example.com/items/1',
      'curl -K req.cfg https://example.com',
      'tsc -p tsconfig.json',
      "awk 'BEGIN {system(\"touch output.txt\")}'",
      'git -c diff.external=./custom-diff diff --ext-diff',
      'cat <<EOF$X\nhi\nEOF$X\nrm -rf tmp',
      'mystery-tool --fast',
      'git status && sqlite3 x.db "select…',
    ]) expect(done(command), command).toBeUndefined()
  })
})
