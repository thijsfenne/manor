---
name: Manor
description: A quiet, rounded workspace where personas carry the color.
colors:
  night-canvas: "light-dark(#eef0f3, #0c0d0e)"
  room-surface: "light-dark(#ffffff, #0f1011)"
  inset-charcoal: "light-dark(#f5f6f8, #191a1b)"
  raised-charcoal: "light-dark(#ffffff, #191a1b)"
  composer-fill: "light-dark(#ffffff, #171819)"
  inhabited-fill: "light-dark(#eceef2, #26262b)"
  user-bubble-fill: "light-dark(#e3e5e9, #26262b)"
  bubble-fill: "light-dark(#e8eaee, #191a1b)"
  picked-fill: "light-dark(#d2d6dd, #6b6f78)"
  quiet-hairline: "light-dark(rgb(0 0 0 / 11%), rgb(255 255 255 / 8%))"
  house-ink: "light-dark(#16181b, #f7f8f8)"
  quiet-silver: "light-dark(#565b66, #8a8f98)"
  distant-silver: "light-dark(#616773, #62666d)"
  primary: "light-dark(#16181b, #f7f8f8)"
  primary-hover: "light-dark(#000000, #ffffff)"
  on-primary: "light-dark(#ffffff, #08090a)"
  control: "light-dark(#3d4451, #26262b)"
  skill-violet: "light-dark(#7c4ddb, #a78bfa)"
  success: "light-dark(#056b4b, #10b981)"
  warning: "light-dark(#8a5d00, #f2c94c)"
  warning-fill: "light-dark(#b58800, #f2c94c)"
  danger: "light-dark(#b02c24, #eb5757)"
  busy: "light-dark(#1155cc, #4a9eff)"
  syntax-comment: "light-dark(#68707e, #787f8a)"
  syntax-keyword: "light-dark(#7c3fb4, #c084fc)"
  syntax-string: "light-dark(#347845, #86b88f)"
  syntax-number: "light-dark(#9a5b16, #e5ad67)"
  syntax-type: "light-dark(#15718e, #67b7d1)"
  syntax-function: "light-dark(#285fac, #7aaaf5)"
  syntax-property: "light-dark(#3b4048, #d3d7de)"
  syntax-operator: "light-dark(#565b66, #b0b5bd)"
  persona-accent: "var(--accent)"
  persona-accent-foreground: "var(--accent-fg)"
typography:
  display:
    fontFamily: "Season Mix, Geist Variable, SF Pro Rounded, ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Geist Variable, SF Pro Rounded, ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Geist Variable, SF Pro Rounded, ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Variable, SF Pro Rounded, ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "-0.011em"
  label:
    fontFamily: "Geist Variable, SF Pro Rounded, ui-rounded, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
rounded:
  xs: "var(--radius-xs)"
  sm: "var(--radius-sm)"
  chip: "var(--radius-chip)"
  md: "var(--radius-md)"
  lg: "var(--radius-lg)"
  panel: "var(--radius-panel)"
  button-sm: "var(--radius-button-sm)"
  button: "var(--radius-button)"
  xl: "var(--radius-xl)"
  composer: "var(--radius-composer)"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.button}"
    padding: "6px 14px"
  button-secondary:
    backgroundColor: "color-mix(in srgb, var(--color-text) 8%, transparent)"
    textColor: "{colors.quiet-silver}"
    typography: "{typography.body}"
    rounded: "{rounded.button}"
    padding: "6px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.quiet-silver}"
    typography: "{typography.body}"
    rounded: "{rounded.button}"
    padding: "6px 14px"
  button-danger:
    backgroundColor: "color-mix(in srgb, var(--color-danger) 12%, transparent)"
    textColor: "{colors.danger}"
    typography: "{typography.body}"
    rounded: "{rounded.button}"
    padding: "6px 14px"
  input:
    backgroundColor: "{colors.inset-charcoal}"
    textColor: "{colors.house-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "7px 10px"
  navigation-active:
    backgroundColor: "{colors.inhabited-fill}"
    textColor: "{colors.house-ink}"
    rounded: "{rounded.xl}"
    padding: "0 12px"
    height: "36px"
  pill-picked:
    backgroundColor: "{colors.picked-fill}"
    textColor: "{colors.house-ink}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  dialog:
    backgroundColor: "{colors.room-surface}"
    textColor: "{colors.house-ink}"
    rounded: "{rounded.xl}"
    padding: "20px"
  composer:
    backgroundColor: "{colors.composer-fill}"
    textColor: "{colors.house-ink}"
    rounded: "{rounded.composer}"
    padding: "12px"
---

# Design system for Manor

## Overview

**Creative North Star: "The Quiet House"**

Manor feels like a calm, precise, inhabited workspace rather than a generic developer tool. Its rooms are achromatic and quiet. The people inside them provide the color, motion, and character. Continuous corners and tonal fills soften a dense desktop tool without making it toy like, while the type stays even and quiet.

Soft precision governs the details. Controls are compact but readable, state changes are direct, and motion explains arrival, departure, progress, or spatial relationship. Decorative effects do not compete with the work.

**Key Characteristics:**

- Achromatic house chrome with persona owned color.
- Tonal depth before borders, and borders before shadow.
- Two type weights, continuous corners, and compact readable controls.
- Purposeful motion with a complete reduced motion path.
- Desktop density that stays personal rather than technical.
- A native project inbox with platform chrome, never a scaled desktop shell.

## Colors

The palette is a quiet room built from near black, paper white, charcoal, and silver. Dark and light themes reverse the depth axis while preserving the same semantic roles.

### Primary

- **House Ink** (light #16181b / dark #f7f8f8): The achromatic interaction color. It carries primary actions and any focus state that does not belong to a persona.
- **Persona Accent** (var(--accent)): Runtime data that identifies who owns a message, control, or active state. It must never be replaced by a fixed brand hue.

### Secondary

- **Skill Violet** (light #7c4ddb / dark #a78bfa): Identifies invoked knowledge such as skill mentions. It is semantic, not decorative.

### Tertiary

- **Success Green** (light #056b4b / dark #10b981): Communicates successful completion only.
- **Warning Gold** (light #8a5d00 / dark #f2c94c): Communicates waiting, caution, or user attention only.
- **Warning Fill** (light #b58800 / dark #f2c94c): The same caution on bars, rings and dots (`warn-fill`). Light text stays Warning Gold because yellow text does not read on white; fills carry no words and only need 3:1.
- **Danger Red** (light #b02c24 / dark #eb5757): Communicates failure or destructive action only.
- **Busy Blue** (light #1155cc / dark #4a9eff): Communicates provider neutral work in flight.

File type colors identify content types and remain subordinate to filenames.

Usage series colors (`--color-series-*`) identify a provider on the Usage pages only: Claude coral #d97757, Codex the House Ink of the theme, Grok a 55% ink mix, Cursor #5b9bbd. The chart, the share bars and the limit bars share them.

Syntax colors belong to source content rather than chrome. Comments, keywords,
strings, numbers, types, functions, properties, and operators keep the same roles
across languages, with separately composed light and dark values that clear AA on
their code surfaces.

### Neutral

- **Night Canvas** (light #eef0f3 / dark #0c0d0e): The outer room.
- **Room Surface** (light #ffffff / dark #0f1011): Holds persistent chrome and cards.
- **Inset Charcoal** (light #eef0f3 / dark #191a1b): Carries hover states, fields, and inset areas.
- **Raised Charcoal** (light #ffffff / dark #191a1b): Reserved for genuinely floating surfaces such as menus and popovers.
- **Composer Fill** (light #ffffff / dark #171819): The composer card. A hair darker than Raised Charcoal in the night room.
- **Composer Tray** (light #f3f4f6 / dark #121314): The checkout strip under the composer and the Changed files card, and the desktop sidebar in dark. A hair lighter than Room Surface in the night room, still darker than the rejected #141516 lift; one grey step below the white stage in light.
- **Inhabited Fill** (light #eceef2 / dark #26262b): Marks selected rows and the user's own message surface.
- **Picked Fill** (light #d2d6dd / dark #6b6f78): Separates selected pills from idle tonal controls.
- **Quiet Silver** (light #565b66 / dark #8a8f98): The first supporting text tier beneath House Ink.
- **Distant Silver** (light #616773 / dark #62666d): The quietest readable text tier on desktop.
- **Quiet Hairline** (light rgb(0 0 0 / 11%) / dark rgb(255 255 255 / 8%)): Separates adjacent regions without becoming a visible frame.
- **Composer Line** (light rgb(0 0 0 / 18%) / dark the Quiet Hairline): The composer's edge and the decision dock's above it. Firmer in light, where the card is white on a white stage.

The desktop window is an L-frame (`--color-frame`, `--color-sidebar`, `--color-stage`). The rail and the top bar are one frame surface: Inset Charcoal's dark step in dark (#191a1b, the lightest in the dark room), its own #e6e8ec in light. The sidebar sits on Composer Tray in dark (#121314) and a clear step below it in light (#f0f1f3), so it parts from the white stage and still sits above the frame. The stage is Room Surface (light #ffffff / dark #0f1011), the darkest in the dark room. The seam between sidebar and stage is the frame's colour. On the frame, every hover, open and picked fill is `--color-frame-fill` (light #d6dae0 / dark Inhabited Fill), because `surface-2` is the frame itself. In light the sidebar's own fills are drawn from the sidebar (`.sidebar-surface`: hover #e9eaed, picked #e5e6e8), because it sits a step below the white stage; picked stays light enough for 4.5:1 text. In every light theme `surface-2` keeps Manor's step below the stage (about 1.14:1), so group headers and hover fills on the stage read on a tinted page too; picked fills sink a further 3% toward text.

### Named rules

**The One Chromatic Voice Rule.** House chrome stays achromatic. Persona colors carry identity, while violet and status colors appear only when their semantics are active.

**The Theme Polarity Rule.** Light is not an inversion of dark. Token roles stay fixed while the luminance stack reverses around a white upper surface.

**The Native Contrast Rule.** Dark native surfaces use Quiet Silver (#8a8f98) for low emphasis text instead of the desktop Distant Silver value (#62666d). Compact metadata and placeholders must remain readable on inset surfaces.

## Typography

**Display Font:** Season Mix Medium on trial (`--font-display` on the Mac, `fonts.display` on the phone) for place and document titles only, once per screen: page headings, the sidebar and house menu name, the sign-in welcome. Never chat, dialogs, sheets or rows. The trial files are gitignored on both platforms, so a fresh checkout falls back to Geist Medium. Without the trial the display stack is Geist, with SF Pro Rounded behind it on Apple devices and the system face as the portable fallback.

**Body Font:** Geist, same stack.

**Label/Mono Font:** SF Mono, the system face, for paths, shortcuts, code, and exact identifiers. Code never forms ligatures, so `!=` stays two characters in every code font.

**Font Choice:** On desktop and web, Settings → Appearance swaps the body font and the code font for one of a fixed bundled list, each with a live sample under its row (a message with chips, a diff). Geist and SF Mono are the defaults, a choice is kept per device, and page titles follow the body font. Geist sits in the main stylesheet and SF Mono is the system face; every other face is bundled, never fetched from a font service, and loads only once chosen or once its menu opens to show the names. The phone keeps its own fonts.

**Character:** Even, open letterforms with a tall x-height, quiet enough to read all day and precise rather than technical. The house gets its softness from continuous corners and tonal fills, not from the type.

### Hierarchy

- **Display** (weight 500, 24px, letter-spacing -0.02em): New chat prompts and the largest stage headings.
- **Headline** (weight 500, 20px, letter-spacing -0.01em): Dialog titles and major panel headings.
- **Title** (weight 500, 16px, letter-spacing -0.01em): Strong local hierarchy, names, and compact headings.
- **Body** (weight 400, 16px, line-height 1.6, letter-spacing -0.011em): Conversation and general interface copy.
- **Card** (weight 400 or 500, 14px, line-height 20px, `text-card`): Body text of the cards inside a turn (ask, permission, secret, connect, outbound draft) in every column, so they stay in step. Their buttons keep their own sizes; meta lines inside them stay Label or Metadata.
- **Label** (weight 500, 13px, line-height 18px): Field labels, hints, menu rows, and supporting controls.
- **Metadata** (weight 400, 12px, line-height 16px): The smallest text role and the hard readability floor.

Markdown inside a message is the one place sized in em rather than pixels, because the reading size is per column, 15px on the stage (DMs and Sessions alike) and 14px in the side panel. Its headings step to 1.25em, 1.15em and 1.08em above the body, and the last two ranks fall below it in the muted color instead of climbing further.

### Named rules

**The Two Weights Rule.** The house has 400 and 500 and nothing else. Emphasis nudges rather than shouts, so a heading earns its rank from size, color and case, never from a heavier cut. The `font-semibold` utility survives because it marks intent, but it resolves to 500.

**The House Sans Rule.** Geist is the house sans on the Mac, the web and the phone, because it reads neutral. The phone loads it as four registered cuts (400 and 500, each upright and italic), because a family stack does not exist there, and draws every size at 0.94 of its stated value (`fontScale` in the theme) as its own size dial, since Geist's lowercase is taller than Figtree's. Figtree stays a pick in Appearance, and where Geist is not yet loaded the stack falls to SF Pro Rounded and the system face.

**The One Family Per Cut Rule.** Native text finds a face by family name and synthesizes neither a weight nor a slant, so every cut the phone uses is registered as its own family and the shared Text component resolves which one a run needs. A design that asks for a weight the app does not register renders as regular, silently.

**The Native Type Safety Rule.** Native screens support large Dynamic Type. Reading content scales with the system, while dense chrome may cap its maximum scale where uncapped labels would collide with adjacent controls.

## Layout

Manor is a desktop workspace arranged around one central stage. A resizable left sidebar runs from 232px to 420px with 288px as its default. The right rail is 44px wide and opens task specific panels beside the stage. The agents panel occupies 372px, while content heavy panels may resize or expand over the stage. Desktop Work can split that stage into two threads, each with its own transcript, composer and rail, divided by a draggable hairline. Both occupied sidebar rows keep static selected fills; focus is shown inside the panes without a travelling fill between thread cards. Both rails keep their own open panel and selection across focus changes. Each panel keeps its chosen width as its owning pane resizes, floats over that chat when docking would leave less than 375px for the transcript, and only narrows when the pane cannot contain it. The pane clips outgoing motion. A 24% canvas wash quiets the whole unfocused pane; its title in the top bar turns Quiet Silver while its panel doors and close stay at full strength. The breadcrumb sets the project name and the thread title in 14px type beside a 15px project icon, so long titles keep more of their words before they truncate.

The desktop chrome is an L-frame. A 46px rail runs down the left and continues as a 38px top bar across the full width; the sidebar and the stage sit together in one inset with a 4px frame gutter on the right and bottom, and 26px corners (`--radius-frame`, a docked panel's 18px plus the 8px gutter it keeps, so the two are concentric). The top bar is laid out on the content's columns: the lead area over rail and sidebar holds the traffic lights (macOS window only), then the sidebar toggle, Back and Forward; full screen and the plain browser move those three over the rail instead, so with the sidebar pinned nothing right of its column moves. Each pane's breadcrumb starts at that pane's left edge behind a 20px hairline, its panel doors and close at its right; the first hairline stands over the sidebar's seam, or close after Forward when the sidebar is folded or the page has none, and a split's stands exactly over the pane border. Both follow a resize. Fields in the bar sit on the stage colour so they read as wells in the frame. The right panels share the sidebar's fill and its deeper light fills (`.sidebar-surface`); documents inside them, diffs and file previews, stay on the stage. Pages with a heading open it 40px below the bar, list pages start 32px down. The pane itself carries no header. Connecting… and Offline sit at the far right, before the last group's doors. The phone keeps its in-place header and one conversation.

Each split pane has a minimum width of 375px including its rail, so splitting requires at least 750px of stage space.

Conversation stays in a centered 780px reading column with 32px between major turns. The new chat surface may grow to 900px so its question and composer have room to breathe. The composer remains a row in layout; its transparent footer overlaps the transcript by one corner radius so messages pass behind the rounded card without a rectangular cutoff.

Spacing is compact and deliberately local. Repeated rows use 2px to 6px gaps, control clusters use 8px to 12px, cards and dialogs use 12px to 20px, and major conversational rhythm uses 32px. Arbitrary values are acceptable only when they solve a measured alignment or interaction seam already present in the interface.

The desktop layout remains the primary work surface. The native phone companion has its own inbox first information architecture rather than inheriting the desktop sidebar. It opens to active project chats above collapsible Settled history. Menu, search, and Compose sit in a rounded native glass control cluster at the bottom, clear of the scrolling rows.

The mobile inbox is a plain messaging inbox, visually Manor through Quiet House neutrals, flat edge to edge rows, restrained semantic color, and rounded platform chrome. On iPad, the native reading column stays centered at a maximum width of 760 points instead of stretching rows across the full screen.

## Elevation & Depth

Manor is tonal by default and uses as little shadow as possible. Luminance, fill, and a translucent hairline should solve separation first. Shadow is allowed only when a surface genuinely overlaps another layer and tone alone cannot explain that relationship.

### Shadow vocabulary

- **Sticky Separation** (`0 6px 14px rgb(0 0 0 / 34%)`): Appears only after content scrolls beneath a fixed bar.
- **Compact Float** (`0 6px 18px rgb(0 0 0 / 45%)`): Reserved for a small floating status pill.
- **Popover Float** (`0 10px 28px rgb(0 0 0 / 50%)`): Separates a temporary popover from moving content beneath it.
- **Menu Float** (`0 12px 32px rgb(0 0 0 / 45%)`): Belongs to menus that portal above their source.
- **Composer Float** (`0 18px 55px rgb(0 0 0 / 38%)`): The broadest allowed shadow and must not spread to ordinary cards.

Light theme elevations add a subtle contact layer because diffuse shadow alone disappears on white. They remain exceptions, not decoration.

Native glass is reserved for platform chrome that genuinely floats above content, including the bottom menu, search, and Compose controls. Inbox rows remain flat and shadowless.

### Named rules

**The Least Shadow Rule.** Use tone first, a hairline second, and shadow only for unavoidable overlap. Resting cards, rows, and panels stay shadowless.

## Shapes

Manor uses a progressive squircle system. Chromium receives continuous `corner-shape: squircle` geometry and a compensation multiplier. Other browsers keep circular arcs at the original optical size. Full circles and pills explicitly remain round.

The global radius scale is 1.25. Small marks start at the extra small and small tokens, field controls use medium or large corners, panels use the panel and extra large steps, and the composer owns the softest dedicated radius. Buttons use their own small and regular radius steps because their corners must remain legible at compact heights.

**The One House Radius Rule.** Use the shared radius tokens. A one off radius is justified only by a measured silhouette that the scale cannot express.

## Components

### Buttons

- **Shape:** Soft but controlled, using the dedicated small and regular button radii.
- **Primary:** House Ink fill with the inverse text color. Medium buttons use 14px horizontal and 6px vertical padding.
- **Secondary:** An 8% wash of the text color with muted text, increasing to 13% on hover.
- **Ghost:** Transparent at rest and tonal on hover.
- **Danger:** A restrained wash of the danger color, never a solid alarm block by default.
- **Hover / Focus:** Hover changes fill or text contrast. Keyboard focus uses the 2px persona aware ring unless the control is field shaped.

### Chips

- **Style:** Toggle pills use two solid tonal fills and no border. Unselected is Inhabited Fill with Quiet Silver. Selected is Picked Fill with House Ink.
- **State:** The full pill is one control and one tab stop. Information stays in a tooltip rather than creating a second nested control.
- **Segmented navigation:** The group stays transparent. Only the selected segment receives Inhabited Fill; never draw one capsule behind the entire control.
- **Compact segmented choice:** 28px segments that hug their content, for a choice sharing a row with its label (the theme in the account popover). Icons alone where the row already names the choice.

### Cards / Containers

- **Corner Style:** Panels use the panel or extra large radius. The composer uses its own larger radius.
- **Background:** Persistent cards use Room Surface. Insets use Inset Charcoal. Only floating cards use Raised Charcoal. The composer uses Composer Fill. The checkout tray and the Changed files card use Composer Tray.
- **Shadow Strategy:** Shadowless by default. Follow the Least Shadow Rule.
- **Border:** Quiet Hairline only where adjacent tonal surfaces still need a seam.
- **Internal Padding:** 12px for compact cards and 20px for dialog forms.

### Inputs / Fields

- **Style:** `field` fill (Inset Charcoal in dark; on the light stage 60% of the way from the surface to `surface-2`, #f5f6f8 in Manor, so a form does not read as grey blocks on the page; inside the light sidebar it takes the sidebar's hover fill), Quiet Hairline border, large radius, House Ink text, and Distant Silver placeholder copy.
- **Focus:** Text fields, and the select and date triggers that sit beside them, lift their own border to `field-focus`: Distant Silver over whatever the field sits on, 55% in dark and 35% in light, so it stays closer to the surface in both modes and every theme. They do not add a second external focus rectangle. The image note field keeps its mark colour.
- **Error / Disabled:** Errors use Danger in copy or a restrained wash. Disabled controls stay visible at roughly 45% opacity and lose the pointer cursor.

### Navigation

Sidebar and rail navigation use tonal rows instead of outlined tabs. Rows are 36px high in the primary navigation and may become 28px in nested lists. Active rows use Inhabited Fill. Hover uses Inset Charcoal. Icons are HugeIcons Pro core stroke rounded, with solid variants reserved for selected states. The repository explorer uses Trees' compact density with 14px labels in 32px rows, an 8px outer inset, smaller folder chevrons, neutral Tree Hover, one-level expansion, flattened empty directories, complete file marks, and hides the implied root when only one folder is linked. Search heads the tree column in 12px type and replaces the tree with flat 12px filename and path results. Only the matched characters carry weight, semibold in both halves, so the row shows why it qualified. Both halves truncate independently inside the fixed tree width, and searching suppresses the viewer's idle empty state. Files opens at 570px and resizes down to a 360px track, with a fixed 240px tree and at least 320px of file content when both columns fit. Its single top toolbar keeps the tree toggle and closable active file tab left, with Save, Open, expand, and panel close right; the file column carries its own breadcrumb row below. Open uses a local 14px label, then collapses to one app icon at the tightest widths. That icon opens the application menu, so functionality does not disappear. Below the two-column threshold, an active file keeps the viewer and hides the tree, while an empty viewer yields to the tree. The toggle swaps between them without discarding the editor, closing the active tab clears the viewer, and widening restores both columns. Safe text files autosave after a short idle beat and retain a manual Save action. Markdown opens in reading view, with one code or preview icon in the file header switching modes. When pinned navigation removes the room that a wide Files panel used, Files floats over the chat and keeps its resize edge available; the chat retains its 375px layout floor underneath. Only the explicit expand action may take the full stage. A host-advertised split button keeps the selected app and opens the saved file only from its primary logo and Open action. Its docked width may grow until only the transcript floor remains. Code files use the GitHub syntax palette with monospace line numbers, and the file header names the full path as breadcrumbs. Knowledge docks beside a thread on the same Files track (570px default, 360px floor, 240px tree), already in the live-preview editor, with idle autosave, a live disk refresh of the open note, and the 46rem reading measure. The sidebar Knowledge row docks that panel when a thread is on stage and still opens the full vault home when it is not. Phone keeps the dedicated Knowledge screen. Folder and control icons outside the repository explorer stay HugeIcons.

A provider CLI with a newer release announces itself in a toast at the top centre of the stage. A warning mark and a one line title sit over the version jump, followed by Update for one provider, or Review updates and Update all for several. The mark centres on the title's line, and the close button sits 10px from the top and right edges alike. Dismissing it holds for that release only and moves the update to a dotted button at the foot of the right rail, which opens the same rows with a per-provider Update. A running update becomes a pill with a spinner, which swaps in place to a check and the providers updated, then leaves after a few seconds. A failure returns as a card with the updater's reason and Retry. The toast drops 10px on `TOAST_IN` and lifts on `TOAST_OUT`. The phone shows none of it, because the update runs on the Mac.

The rail's foot holds the provider-update door, the usage rings and the account face. The face opens a 320px popover hung 12px off the rail: photo and name, a one-line Usage row with each provider's mark and percentage left beside the label (no "left" word, no chevron; 320px is what four plans at 100% need), an inline theme choice, and Settings with its ⌘, hint. Settings itself is a large modal over the whole window (at most 1120 by 860px, on the scrim, the workspace mounted and inert underneath): a 240px page list on the left (the Settings title and search, group headers in 12px Distant Silver, 32px rows with the travelling selection fill), the page on the right, and a close button in the top right corner. Escape, the close button or a press outside closes it; it rises in and sinks out through motion/react and reopens on the page shown last. Usage is not a Settings page; it is its own page with a Back crumb, from the rings' pop-up or the account popover's Usage row. Form pages read in a 720px column; list-and-detail pages use the page width. A page scrolls as one, its title included; on Agents the agent list sticks beside the form while it scrolls. Appearance picks the mode from three cards, System first, each a miniature Manor (sidebar, clouds, composer) drawn from the picked theme's palette in `colorThemes.ts`, System split light and dark down the middle; the chosen card wears a 2px House Ink ring and the arrows move the choice. Below it each colour theme is a card with two orbs, light left and dark right, each its own bubble fading into its accent; a picked orb wears a 2px House Ink ring and a sun or moon badge. Manor writes no CSS; any other theme is one generated sheet over the same tokens, its derived steps following the relations of Manor's own values. Rows are label, one line of why, and the control, divided by Quiet Hairlines with no card behind them. Pages with an explicit Save end in a sticky bar with the saved state, Discard and Save.

Native mobile navigation begins at the project inbox rather than the desktop sidebar, household, or a direct message directory. Active project chats lead, Settled history collapses beneath them, and Menu, search, and Compose use native rounded glass controls. Dedicated direct message agent navigation is deferred.

### Composer

The composer is Manor's primary work surface. It uses Composer Fill, Composer Line, 12px internal padding, and the dedicated composer radius. The checkout tray under it uses Composer Tray, so the seam is luminance without a second outline. It has no focus decoration because the caret rests there by default. Attachments, page context, mention pills, runtime controls, and send state stay inside one coherent card.

The desktop model picker has a stepped effort slider and a frozen trigger label. Each stop comes from the selected model's supported efforts. The slider stays open while adjusting. Reset restores the original persona or Single default, preserving that preference even when the current model displays a supported fallback. Reset is disabled when the displayed effort already matches that effective default. Where the model has a fast tier, a Flash toggle sits top left in the slider header, opposite reset; stroke when Standard, solid and selected when Fast, and it keeps the picker open like the slider. It replaces the old Speed rows; the side chat never shows it. It uses a 32px tonal track, a 36px House Ink thumb from `--spacing-slider-thumb` that overhangs the track, and a 44px input target. The model list scrolls independently above the slider. The roster panel grows to 640px so all eleven Cursor models fit; only a short window makes the list scroll. While open, the original model, provider mark and speed badge keep sizing the trigger invisibly beneath “Select effort”; the label fades using `TEXT_SWAP`, with no motion when reduced motion is enabled. Width updates only on dismissal. Native mobile retains its platform sheet and named effort rows, reading the same shared capability rules.

On native mobile, Compose opens one platform sheet. It offers an existing project or a folder browser backed by the connected Mac, then carries that project into the first message draft. The selected folder stays on the Mac because the phone is a companion to the host runtime, not a second filesystem.

### Ask card

The ask card is a compact walk through one question at a time. It wears the right panel's surface (`SIDE_SURFACE`: Composer Tray with a hairline, the same as the Session proposal card, the outbound draft card and the plan), tonal option rows, a persona tinted step chip, and measured height transitions. It sits directly above the composer while active and becomes a quiet transcript record after completion.

### Persona toolset

The persona dialog's toolset uses plain capability rows with one short explanation and a group switch. Partial groups show a centered thumb and “Some on”; these switches use checkbox semantics so assistive technology can announce the mixed state. A gear button to the left of each switch reveals the individual tool names below its row. Background work, scheduling, provider features and extra names live under a collapsed Advanced disclosure. Claude and Grok expose the controls their drivers support, with the linked-folder and implicit-tool exceptions stated alongside them. Codex, Cursor and Mock show disabled saved preferences with an explanation, never implied per-tool permissions. Viewing, changing provider or saving without tool edits preserves the original `allowedTools` list, including unknown names and order.

### Persona faces

Blobatar faces are deterministic from a persona's name, colored by her accent, and animated at every size. A face in the transcript also shows what her turn is doing, with her eyes, a pose and a body gesture. On the phone that is the face behind the latest reply and the one in a DM's working line. Their SVG shares the nominal slot's exact dimensions, so the avatar never exceeds its wrapper. Uploaded portraits remain circular and override the generated face.

## Do's and Don'ts

### Do:

- **Do** use the existing semantic tokens so dark and light themes move together.
- **Do** let persona color identify ownership while keeping shared chrome achromatic.
- **Do** use tonal layering before adding borders or shadow.
- **Do** keep controls compact without dropping below the 12px metadata floor.
- **Do** use motion to explain state, sequence, or spatial change and preserve reduced motion behavior.
- **Do** keep the central conversation readable and protect it from side panel overlap.
- **Do** use native sheets and rounded glass chrome for mobile controls while keeping inbox rows flat.
- **Do** keep native mobile reading content within a centered 760 point column on iPad.

### Don't:

- **Don't** introduce a fixed chromatic brand accent beside persona colors.
- **Don't** add shadow to resting cards, rows, or panels when tone can separate them.
- **Don't** use font weights above 500 or oversized type to manufacture hierarchy.
- **Don't** use emoji, ad hoc inline SVG, or an icon family other than HugeIcons and the named Trees file-mark exception in product UI.
- **Don't** turn every section into an outlined card or every state into a bordered pill.
- **Don't** join labels or metadata with a middle dot ("Weekly · Fable", "max · at 10:00"). Write a shorter label, give each piece its own element with a gap, or use a comma in a sentence.
- **Don't** treat the native mobile experience as a scaled down desktop shell or make the desktop sidebar its primary navigation.
