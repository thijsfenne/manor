# Browser saved passwords

The key in the Browser's address field fills a saved login, a strip under the address row offers to save one after a sign-in, and the Browser settings (menu, then the settings item) list saved passwords with remove and remove all.

## How to get to it (user POV)

- Rail `Browser`, or a Session's `Panels` door `Browser`.
- Key: the active stub tab `Albert Heijn` (`www.ah.nl`) has one saved login from Dia.
- Offer: type `https://login.example/` in `Address` and press Enter.
- List: the key menu's `Manage passwords`. It holds `login.example` (Manor), `www.ah.nl` and the Never site `news.example` (both from Dia), each with a remove button.
- Sign-in popup: type `https://signin.example/` in `Address`. The group `Sign-in window` shows `login.example` with the key.
- List failure: type `https://fail.example/`, then open the list; it shows an alert with `Try again`, and the retry loads.

## Driving it with control-manor

```bash
MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-browser.js node .cursor/skills/verify-manor/control-manor.mjs launch
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Browser --exact --within navigation
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name "Saved passwords" --exact
node .cursor/skills/verify-manor/control-manor.mjs press --key Enter
node .cursor/skills/verify-manor/control-manor.mjs fill --role combobox --name Address --value "https://login.example/"
node .cursor/skills/verify-manor/control-manor.mjs press --key Enter
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Save --exact
```

The stub shows a fill as the active tab's title, `Filled <username>`, because no page renders. The offer group is `Save password for login.example?` with `Save`, `Never` and `Not now`; the list is the region `Saved passwords`.

## Gotchas

- Capture from a real form, fill into a real page, the other-origin refusal and the sign-in popup are native behaviour; prove those with `pnpm --filter @manor/desktop smoke:browser-passwords`, not the stub.
- The stub's `Never` adds a removable Never row but does not block later offers; only the real store suppresses them.
- The stub reports Dia mode off while listing Dia entries; that combination is fixture-only.
