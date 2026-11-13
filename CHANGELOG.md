# Changelog

What changed for someone who uses Manor, newest first. A version is a tag on `main`. The root, server, web, desktop, contracts and client runtime packages carry the same number. The phone companion and the blobatar copy keep their own.

## Unreleased

- After you push a branch, the Session panel shows the pull or merge request page your remote offers, one click away. It needs no sign in in Manor.
- A push that fails because this Mac is not signed in to the remote now says so and names the way out, instead of repeating Git's last line.
- The README says that agents use your own git and `gh` sign in.
- An agent's own `git push` over ssh now works with a key the macOS ssh agent holds, as it does in your Terminal.
- A new Session can work in a folder without making a project. On an empty install the chip reads Add folder and opens the folder picker. Folders stay in the list until you remove them, which keeps their Sessions. Projects' + menu turns a folder into a project with a thread. The picker no longer creates projects.

## 0.1.0, 2026-11-13

The first public version. Manor is source only for now, so you build the app yourself. See `README.md`.
