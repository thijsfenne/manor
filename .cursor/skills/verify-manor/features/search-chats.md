# Search

The ⌘K palette. It opens from the `Search` button in the top bar (right after `Back` and `Forward`) or with ⌘K. On an empty query it lists up to nine recent chats; a query returns one ranked list of chats, messages, notes and reminders, each option starting with its type (`Chat`, `Message`, `Note`, `Reminder`). `New chat` is always a quick action.

## Sub-features

- `search-open` opens dialog `Search` from the top bar's `Search` button.
- `search-shortcut` toggles the same dialog with ⌘K.
- `search-hit` lists matches of every type as options, best first.
- `search-miss` shows status `Nothing matches` plus the `New chat ⌘N` option.
- `search-message` opens a message's chat, lands on that message and washes it for 1.5s, also when it sits above the rendered page.
- `search-note` opens a note in Knowledge; ⌥Enter opens it in the docked Knowledge panel beside the open chat.
- `search-reminder` opens Reminders with that reminder selected and its details shown.
- `search-close` closes on Escape.

## How to get to it (user POV)

- Click the magnifier in the top bar (tooltip `Search (⌘K)`), or press ⌘K anywhere.

## Driving it with control-manor

Preconditions: spike healthy. Notes need a fixture vault and reminders a fixture RemCTL, see below; without them those two types simply never appear.

- **Open.** `click --role button --name Search --exact --within banner`. Expect `dialog "Search"` with `combobox "Search chats, messages, notes and reminders"` and `listbox "Search results"`.
- **Miss.** `fill --role combobox --name "Search chats, messages, notes and reminders" --value zzzx-no-thread`, `wait-settle`. Expect status `Nothing matches` and only the option `New chat ⌘N`.
- **Hit.** Fill a word from a chat's title or a sent message. Expect `Chat …` and `Message …` options; a message option names its author (`You`, or the persona) and the project.
- **Older message.** Send about 30 messages in one chat after the one to find, reopen the chat (it then renders only the latest page), search a word from the first message and pick its `Message` option. Screenshot within ~0.4s to catch the wash.
- **Close.** `press --key Escape`. No `dialog` remains in the ARIA snapshot.
- **Proof.** `snapshot --aria` after the miss and the hit; screenshots of the list and of each pick.

## Fixtures for notes and reminders

- **Vault.** Put a few `.md` files under a folder in `/tmp` and launch with `MANOR_VERIFY_VAULT_DIR=/tmp/<folder>`. The launcher refuses anything outside `/tmp`, so the real vault never reaches the spike.
- **Reminders.** The server looks for RemCTL in `$HOME/bin/remctl` first, and the spike's HOME is `/tmp/manor-electron-spike/home` (or `…-<port>/home`). A `/bin/sh` script there that answers `workspace` with a JSON fixture (shape in `apps/server/test/reminders.test.ts`) and `list-info` with `{"shared":false,"sharees":[]}` stands in for it. A mock run (`MANOR_DRIVER=mock`, which the spike always is) looks only there, never at `/opt/homebrew/bin` or `/usr/local/bin`, so without the fixture the spike simply has no Reminders and never reads the maintainer's real list.
- **Windowed layout.** Headless shows the full-screen arrangement. A private init script setting `window.manorDesktop = { platform: 'darwin', onFullscreen }` (`MANOR_VERIFY_INIT_SCRIPT`) shows the traffic-light slot; Playwright presses only F1–F12, so pick one of those if the stub toggles full screen on a key.

## Gotchas

- A miss is not an empty list: `New chat ⌘N` is always present, so assert `Nothing matches`, not zero options.
- The first option is preselected; Enter opens it.
- Messages and notes come from the host after a 120ms pause in typing; `wait-settle` before reading the list.
- The memory store forgets every chat on restart, so seed after the last relaunch.
