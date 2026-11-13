# Browser tabs

The Browser's tab strip shows pinned tabs as favicons and ordinary tabs with a title, shared by the full-page Browser (rail door) and the side panel in a chat. Tabs flex between 90 and 200px, the strip scrolls with an edge fade when they no longer fit, and a tab drags to a new place within its own group while its neighbours slide aside.

## Sub-features

- Full-page Browser from the rail, resized with the window.
- Side Browser panel in a Session chat, resized with its grip.
- Drag reorder inside the ordinary group, clamped at the group's ends.

## How to get to it (user POV)

- Full page: rail `Browser`.
- Side panel: open a Session that has a message, then the top bar's `Panels` door `Browser`.

## Driving it with control-manor

```bash
MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-browser.js node .cursor/skills/verify-manor/control-manor.mjs launch
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Browser --exact --within navigation
node .cursor/skills/verify-manor/control-manor.mjs resize --width 820
node .cursor/skills/verify-manor/control-manor.mjs home
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Sessions --exact --within navigation
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name "New session"
node .cursor/skills/verify-manor/control-manor.mjs fill --composer --value "ping"
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Send --exact
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Browser --exact --within banner
node .cursor/skills/verify-manor/control-manor.mjs drag --role separator --name "Resize side panel panel" --dx 250
node .cursor/skills/verify-manor/control-manor.mjs drag --role button --name Hobbyshop --exact --dx -500 --steps 30
```

The stub seeds every chat with pins `Gmail` and `Calendar` and ordinary tabs `inspace.design`, `uxwork.nl`, `Albert Heijn` (active) and `Hobbyshop`. The ARIA groups are `Pinned tabs` and `Tabs` (pass `exact`).

## Gotchas

- Without the stub the panel says the browser needs the desktop app, and without its `webviews` member it says to update the desktop app; both mean the init script did not load. It loads only on a fresh `launch`, so run `cleanup` first.
- No page ever renders; only the chrome is real. Anything about page content needs the Electron spike.
- Relaunch after a web change before taking after-evidence; `launch` rebuilds the dist when the tree changed, and a drive command refuses a stale one.

## Ad block switch

The address field carries a shield on every web page: `Shield01` while blocking, its label giving the page's count (`7 ads and trackers blocked. Turn off ad blocking on <host>`), `ShieldOff` once switched off for that host (`Ad blocking is off on <host>. Turn it on`). Clicking it reloads the page. While a sign-in popup is open (`https://signin.example/`) the shield sits on the `Sign-in window` group and switches the popup's host, `login.example`. The stub keeps the switch per host for the spike's life; the real blocking, list cache and restart persistence are proven by `pnpm --filter @manor/desktop smoke:browser-adblock`.

```bash
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name "Turn off ad blocking"
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name "Ad blocking is off"
```
