# Changelog

What changed for someone who uses Manor, newest first. A version is a tag on `main`. The root, server, web, desktop, contracts and client runtime packages carry the same number. The phone companion and the blobatar copy keep their own.

## Unreleased

- A persona's face now shows what her turn is doing. She tilts her head while she thinks, follows lines while she reads, melts into three dots while her answer streams in, dozes while she waits on a colleague, turns to you when she needs an answer, nods when she is done and shakes when a turn fails. Any other work keeps the eye loop she already had. Reduced motion and photo avatars show none of it. The phone shows it on the face behind the latest reply and in a DM's working line.
- Persona faces have a richer finish. The light on a face is now tinted from its own colour, small faces are drawn simpler with larger eyes, and in the dark theme a face stands on a glow in its colour, where its shadow could not be seen.
- After you push a branch, the Session panel shows the pull or merge request page your remote offers, one click away. It needs no sign in in Manor.
- A push that fails because this Mac is not signed in to the remote now says so and names the way out, instead of repeating Git's last line.
- The README says that agents use your own git and `gh` sign in.
- An agent's own `git push` over ssh now works with a key the macOS ssh agent holds, as it does in your Terminal.
- A new Session can work in a folder without making a project. On an empty install the chip reads Add folder and opens the folder picker. Folders stay in the list until you remove them, which keeps their Sessions. Projects' + menu turns a folder into a project with a thread. The picker no longer creates projects.

## 0.1.0, 2026-11-13

The first public version. Manor is source only for now, so you build the app yourself. See `README.md`.
