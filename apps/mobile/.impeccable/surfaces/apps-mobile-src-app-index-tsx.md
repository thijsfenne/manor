---
version: 1
slug: "apps-mobile-src-app-index-tsx"
primary_target: "apps/mobile/src/app/index.tsx"
related_targets: ["apps/mobile/src/app/new-chat.tsx"]
---

## Scope and mode

Native iOS project inbox and the new project-chat flow. Operate mode.

## Audience and job

The user checks Manor away from their Mac. They need to see open project work, reopen settled conversations, search quickly, and start a new project chat with one hand.

## Task and proof

The primary action is Compose. The surface proves itself with the real project directory, thread activity, previews, project identity, and host paths. Existing projects remain selectable. A new project comes from a folder on the connected Manor host.

## Constraints

The Mac remains the runtime and filesystem host. No iPhone document picker. DMs, files, diffs, browser control, and project configuration stay outside this slice. Navigation, sheets, touch targets, Dark Mode, and Dynamic Type should behave natively.

## Chosen direction

A messaging inbox with a project sheet, in Manor's Quiet House. Use flat edge-to-edge rows, tonal depth, restrained status color, and a floating bottom tool cluster. The memorable moment is one continuous Compose sheet that moves from project choice through host-folder browsing into the first message without losing context.

## Unresolved

The later DM switch and notification behavior remain open.
