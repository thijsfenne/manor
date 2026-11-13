# Browser find and page zoom

The find bar sits under the Browser's address row; the zoom magnifier sits in the address field while a page is not at 100%.

## How to get to it (user POV)

- Rail `Browser`, then `Browser menu` → `Find on page ⌘F`. The stub pretends every page reads "apples and pears, more apples, apples again", so `apples` finds 3.
- Zoom: `Browser menu` → `Zoom in`. The field shows `Page zoom 110%. Reset to 100%`.

## Driving it with control-manor

```bash
MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-browser.js node .cursor/skills/verify-manor/control-manor.mjs launch
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name Browser --exact --within navigation
node .cursor/skills/verify-manor/control-manor.mjs click --role button --name "Browser menu" --exact
node .cursor/skills/verify-manor/control-manor.mjs click --role menuitem --name "Find on page ⌘F" --exact
node .cursor/skills/verify-manor/control-manor.mjs fill --role textbox --name "Find on page" --value apples
node .cursor/skills/verify-manor/control-manor.mjs press --key Enter
```

## Gotchas

- Keys typed in a page (⌘1 reaching Manor, ⌘F, ⌘⇧T, ⌘+) are native; prove them with `pnpm --filter @manor/desktop smoke:browser-keys`. The spike has no guest and no main-process key routing.
- The stub's `reopenClosedTab` changes nothing.
- Sign-in popup: open find first (the sign-in bar hides the menu), then go to `https://signin.example/`. `apples` finds 3 in the popup; after `Cancel` the page reads "pears only", so the bar must show `No results`.
- The stub's `Reload` loads for 300 ms and then the page reads "pears only", so an open find bar for `apples` must go from `1 of 3` to `No results`. Relaunch to get the apples page back.
