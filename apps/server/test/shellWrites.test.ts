import { describe, expect, it } from 'vitest'
import { shellWriteDestinations } from '../src/drivers/shellWrites.js'

const written = (command: string) => shellWriteDestinations(command, '/home/t')

describe('shellWriteDestinations', () => {
  it('names the targets of output redirects and tee, with quoting kept whole', () => {
    expect(written('echo x >> /a/prefs.md')).toEqual(['/a/prefs.md'])
    expect(written("printf x >> '/a/prefs.md backup'")).toEqual(['/a/prefs.md backup'])
    expect(written('echo x 2>/a/err.log >/a/out.md 2>&1')).toEqual(['/a/err.log', '/a/out.md'])
    expect(written('echo x | tee -a /a/prefs.md')).toEqual(['/a/prefs.md'])
    expect(written("/bin/zsh -lc 'echo x >> /a/prefs.md'")).toEqual(['/a/prefs.md'])
    expect(written(`/bin/zsh -lc 'printf '\\''x'\\'' >> '\\''/a/b c.md'\\'''`)).toEqual(['/a/b c.md'])
    expect(written('/bin/zsh -lc "echo x >> \\"/a/b c.md\\""')).toEqual(['/a/b c.md'])
  })

  it('expands home only where the shell does', () => {
    expect(written('echo x >> ~/a.md')).toEqual(['/home/t/a.md'])
    expect(written('echo x >> "$HOME/a.md"')).toEqual(['/home/t/a.md'])
    expect(written('echo x >> ${HOME}/a.md')).toEqual(['/home/t/a.md'])
    expect(written("echo x >> '$HOME/a.md'")).toEqual([])
    expect(written("echo x >> '~/a.md'")).toEqual([])
    expect(written('echo x >> ~"/a.md"')).toEqual([])
    expect(written('echo x >> $NOTES/a.md')).toEqual([])
  })

  it('counts only commands whose own success the exit status proves', () => {
    expect(written('cd /a && echo x >> prefs.md')).toEqual(['/a/prefs.md'])
    expect(written('test -f /a/p.md && echo x >> /a/p.md')).toEqual(['/a/p.md'])
    expect(written('cd /a && echo x >> prefs.md; ls')).toEqual([])
    expect(written('test -f /a/p.md || echo x >> /a/p.md')).toEqual([])
    expect(written('echo x >> /a/p.md || true')).toEqual([])
    expect(written('cat < /a/missing >> /a/p.md; true')).toEqual([])
    expect(written('cat < /a/missing >> /a/p.md | cat')).toEqual([])
    expect(written('echo x >> prefs.md && echo y >> ../other/prefs.md')).toEqual([])
    expect(written('cd /a < /a/missing; echo x >> prefs.md')).toEqual([])
    expect(written('cd /a && chdir /b && echo x >> prefs.md')).toEqual([])
    expect(written('cd /a && z b && echo x >> prefs.md')).toEqual([])
    expect(written('false || cd /a; echo x >> prefs.md')).toEqual([])
  })

  it('names nothing it cannot read faithfully', () => {
    expect(written('touch -r /a/p.md /b/out.md')).toEqual([])
    expect(written('cp /a/p.md /b/backup.md')).toEqual([])
    expect(written('tee --output-error=warn /a/p.md')).toEqual([])
    expect(written('echo x | tee $FLAGS /a/p.md')).toEqual([])
    expect(written('HOME=/b; echo x >> ~/p.md')).toEqual([])
    expect(written('export HOME=/b && echo x >> "$HOME/p.md"')).toEqual([])
    expect(written('repeat 0 echo x >> /a/p.md')).toEqual([])
    expect(written('echo x >> /a/link/../p.md')).toEqual([])
    expect(written('cd -P /a/link && echo x >> ../p.md')).toEqual([])
    expect(written('cd /a/link/.. && echo x >> p.md')).toEqual([])
    expect(written('echo $(date) >> /a/p.md')).toEqual([])
    expect(written('echo `date` >> /a/p.md')).toEqual([])
    expect(written('if true; then echo x >> /a/p.md; fi')).toEqual([])
    expect(written('set -e; echo x >> /a/p.md')).toEqual([])
    expect(written('echo x >> /a/p.md &')).toEqual([])
    expect(written('(echo x >> /a/p.md)')).toEqual([])
    expect(written('echo x >> /a/*.md')).toEqual([])
    expect(written("echo 'unterminated >> /a/p.md")).toEqual([])
  })

  it('reads a heredoc body as input, not as commands', () => {
    expect(written("cat > /tmp/out.md <<'EOF'\necho x >> /a/p.md\nEOF\necho done >> /a/q.md")).toEqual(['/a/q.md'])
    expect(written('cat >> /a/p.md <<EOF\n- A line\nEOF')).toEqual(['/a/p.md'])
    expect(written('cat <<$HOME\necho x >> /a/p.md\n$HOME')).toEqual([])
  })
})
