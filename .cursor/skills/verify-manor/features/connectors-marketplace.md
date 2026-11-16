# Connectors marketplace

Plugins → Connectors is one page for every connector: a search field, a Connected section (mymind, Manor's own MCP rows and the Composio apps connected under the personal or work alias), then Composio's app catalogue as cards grouped into the page's own categories (Productivity, Communication, Documents, Research, Data, Design, Business, AI, Coding, Other), apps that connect in one click first inside each. On the spike the server's mock Composio serves 28 named apps plus 600 filler apps, three seeded accounts (Gmail personal, GitHub personal, Notion work), and sign-ins that land 6 seconds after Connect. Nothing reaches Composio's API.

## Sub-features

- `marketplace-search` filters own rows, connected apps and the catalogue by name, slug, description and category.
- `marketplace-category` narrows the catalogue with the `App category` tablist. `All` shows eight cards per category with `Show all <n>`; a category shows its cards with `Show more`. Typing a search selects `All` and searches every category; clearing it brings the pick back, and picking a tab clears the search.
- `marketplace-connect` asks for the alias, then shows `Finish in your browser` and lands in Connected.
- `marketplace-connect-failed` shows `Failed`, the reason and `Retry` (the mock app `Failbox` always fails).
- `marketplace-disconnect` asks `Disconnect <app>?` and removes the app from Connected.
- `marketplace-key` is the Composio key. The spike's key lives in server memory, so the page starts with the catalogue and `The Composio key is saved in Manor’s data folder.` with `Remove key`. Removing it (dialog `Remove the Composio key?`) shows the no-key form in the place of the catalogue: `Get a key` (links to `https://dashboard.composio.dev/~/project/settings/api-keys`), the `Composio API key` field and `Save`. A key containing `invalid` is refused with `Composio did not accept this key. Check that you copied the whole project API key.`; any other key of 8 or more letters, digits, `_`, `-` or `.` brings the catalogue back. Nothing is written to disk and nothing reaches Composio.

## How to get to it (user POV)

- Click `Plugins` on the rail; the Connectors tab opens first.

## Driving it with control-manor

Preconditions: spike launched by `control-manor.mjs launch`, then `home`.

- **Open.** `click --role button --name Plugins --exact --within navigation`, `wait-settle`. Expect `Connected` with GitHub, Gmail and Notion (each `Disconnect`), then `Apps 628`, the `App category` tabs and `Productivity 84`.
- **Category.** `click --role tab --name Coding --exact`. Expect `Apps 152`, Failbox and GitHub first, `Show more (32 left)`.
- **Search.** `fill --placeholder "Search connectors and apps" --value "mail"`. Expect Gmail in Connected, Gmail (`Add Work`) and Outlook under Communication, Mailchimp (`Own credentials`) under Business.
- **Connect.** Search `linear`, `click --role button --name "Connect Linear" --exact`, then `click --role menuitem --name "Work account" --exact`. Expect `Finish in your browser`; within 8 seconds Linear appears in Connected as `Composio · Work` and its row offers `Add Personal`.
- **Failed.** Search `failbox`, connect with `Personal account`, wait 8 seconds. Expect `Failed`, `Retry` and `Press Connect again for a fresh link.`
- **Disconnect.** `click --role button --name "Disconnect Linear" --exact`; expect `dialog "Disconnect Linear?"`; confirm with `click --role button --name Disconnect --exact --within-name "Disconnect Linear?"`.
- **Key.** `click --role button --name "Remove key" --exact`, confirm with `click --role button --name "Remove key" --exact --within-name "Remove the Composio key?"`. Expect `Composio connects these apps`. Fill the password field with `ak_invalid_key_1`, `Save`, expect the refusal; fill `ak_spike_key_123`, `Save`, expect `Apps 628` again.
- **Proof.** `snapshot` text after each step, `screenshot` per state.

## Gotchas

- App logos load from `logos.composio.dev`, a public image host, so the headless browser needs the network for them; without it each row shows the app's initial instead.
- Mock accounts live in the spike server's memory: a relaunch restores the three seeded accounts.
- The connect is page-level, not a chat card, so `open_connect_card` never reaches it.
