# Session changes

Where a Session's room links a git folder, the right-hand panel is the Session panel, without a title bar, in titled sections like Synara's environment card: `Agents` (absent in a Single Session), `Environment` (`Changes +N −M` and one Branch line per folder with Commit and Push), `Repository` (the remote's `owner/repo` with a link) and `Editor` (`Open in <app>` with a chevron for the other apps). The `Session` door, Synara's panel-top-open glyph (`PanelTopOpenIcon`), opens and closes it. Changes opens the diff beside the panel. A waiting result turns the row's totals into `N files` in the warn colour (the words `waiting for Confirm` stay for screen readers only), hides Commit and puts Confirm and Request changes on a line under the diff bar. A changed-files card's Review, or the diff's `Turns` menu, opens one turn's diff.

## Sub-features

- `sc-panel` is the panel itself; a DM, a group and a room without git keep the plain Agents panel.
- `sc-diff` is the diff pane: the bar (`Whole Session` pill, `toolbar "Diff tools"` with Reload, `Diff view options`, previous and next, `Jump to file`; the `Turns` pill; `Close diff`), file cards with sticky headers, the change markers, and per file Open in files panel, Reference in chat, Copy path. Stacked or Split (from about 900px) and Hide whitespace live in `Diff view options`.
- `sc-turn` is one turn's diff from Review or `Choose turn diff`, and `Whole Session` back.
- `sc-repo` is the Repository and Editor sections. Never click `Open in …` on the spike: it launches the app on the real Mac.
- `sc-waiting` is a result waiting for Confirm: the row, no Commit, Confirm and Request changes in the diff.
- `sc-commit` is the Commit dialog and `sc-push` the Push click, against a local bare remote.
- `sc-large` is a partial diff past the size limits.

## How to get to it (user POV)

- Link a git folder to the project (`Edit project`, `Add a folder…`), open a Session in it; the `Session` door in `Panels` opens the panel.
- `Changes …` in the panel opens and closes the diff. `Review` on a changed-files card opens that turn.

## Driving it with control-manor

Preconditions: spike healthy, start from `home`. Make a fixture first, outside the spike's data dir: a repo at `/tmp/wren-session-fixture/repo` with one commit, `user.name` and `user.email` set in the repo itself (the spike's HOME has no git identity), and a bare `origin` at `/tmp/wren-session-fixture/remote.git` pushed with `-u`. Never point the fixture at a real remote.

- **Link it.** `click --role button --name Sessions --exact --within navigation`, `click --role button --name "Edit project"`, `click --role button --name "Add a folder…"`, `fill --role textbox --name "Paste an absolute folder path" --value /tmp/wren-session-fixture/repo`, `click --role button --name Add --exact`, `click --role button --name "Save changes"`. The seeded chat's panel now has `region "Environment"` with `Changes None yet` and `main · nothing to push`.
- **Self-started Session.** `click --role button --name "New session"`, send `mock edit: one line`, then `mock code edit: export const x = 1`. The panel shows `Changes +2` and Commit. `click --role button --name "Changes +2"` opens the diff. `click --role button --name Commit --exact`, untick one file (`click --role checkbox --name "mock-result.ts new +1"`), `click --role button --name "Commit 1 file"`; the dialog closes at once, a pill at the top centre spins `Committing 1 file…` while the hook runs, then says `Committed 1 file as <hash>: …` for 3.5s, and Push appears. For a slow or failing hook, point the fixture's `core.hooksPath` at a folder whose `pre-commit` sleeps and prints `apps/web test:  FAIL  test/x.test.tsx` before `exit 1`: the pill turns into the failing files, the Branch line keeps them with `Reopen`, and Reopen restores the message and ticks. `click --role button --name Push --exact`; the toast says `Pushed N commits to origin/main.` Only a refusal stays as a red line under Branch. The toast is gone before `wait-settle` returns, so catch it with a second Playwright client that screenshots right after the click. Check with `git -C /tmp/wren-session-fixture/remote.git log --oneline main`.
- **One turn.** `click --role button --name "Review mock-result.ts"`, or `Choose turn diff: Turns` and a `menuitemcheckbox`; the Turns pill then reads the turn (`Turn · HH:MM`, or the persona's name) and is lit, and `Whole Session` goes back.
- **Waiting result.** In the Marlow DM send `mock start work Smith: Add an export button. Done when it exports.`, `click --role button --name Accept --exact`, open the Session from its card (`Open Session <title>`; Accept no longer does), then send in it `@Marlow mock goal: <result> | <limitation>`. The row reads `Changes 1 file` in the warn colour, the Branch line has no Commit, the diff has `Ready`, `Request changes` and `Confirm` (`--within complementary --within-name Changes`), and the Session's bar above the composer has its own `Ready` row. A worktree Session counts a file written by hand after that as `1 file not included` on the row and under `Not included` in the diff; a shared checkout does not.
- **Reviewed result.** The spike roster has no reviewer, so first add one: `New agent` in the Agents sidebar, Name `Argus`, any Instructions, tick `Works in Sessions`, `Create agent` (the id becomes `argus`). In the Session send `@Smith mock code edit: export const x = 1`, then `@Argus mock review passed`, then the `mock goal` line. The DM card reads `Ready`, `2 files · Reviewed by Argus`; Confirm commits both files and the card folds to `<title> · <first sentence> · Committed`.
- **Memory in a consultation.** In the Marlow DM send `Ask Sage <question>. mock memory: <line>`. The mock records a memory edit for the spike's memory folder path without writing a file. Marlow's acknowledgment carries `Memory updated, 1 change` among its hover icons, `Messaged Sage` and `Message from Sage` follow, and no memory row stands on its own.
- **Large diff.** New session, choose `Current checkout` then `menuitemradio "New worktree"`, send `native helper` (the turn runs about 12s), and during it write many files into the worktree (`git -C /tmp/wren-session-fixture/repo worktree list`; worktree folders of earlier launches stay under `/tmp/manor-electron-spike/worktrees`, so do not pick one by name). Over 3,000 changed lines in one file or 12,000 in all gives `Partial diff…` at the top of the list.
- **Split.** Close the Session panel, focus the diff's own resize handle (open and Escape the file menu, then `press --key Shift+Tab` twice) and `press --key ArrowLeft` until `Diff view options` offers `Split` enabled.

## Gotchas

- Only a prose change escapes the review gate on this roster (no Argus), so the goal Session edits `mock-result.md`; `mock goal` rewrites that file rather than appending.
- For a `Repository` row with a link, give the fixture a GitHub fetch URL and a local push URL: `git remote add origin git@github.com:example/fixture.git` then `git remote set-url --push origin /tmp/wren-session-fixture/remote.git`. The name comes from the fetch URL and Push still only reaches the bare remote.
- In a shared checkout only files a turn named count as the Session's; files written by hand outside a turn never reach Changes or Commit. A worktree takes everything since its branch left the linked folder's branch, files written by hand and commits included.
- A status read error is easiest to cause with an unreadable new file in the Session's checkout (`chmod 000`): the snapshot's `git add -A` fails, Changes shows the error with Retry, and `chmod 644` plus Retry recovers.
- Several Review buttons can share a name when their turns changed the same single file; make each turn touch a different file.
- The tile handles take no focus from a click; keyboard resizing needs Tab.
