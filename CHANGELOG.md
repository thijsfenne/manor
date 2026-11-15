# Changelog

What changed for someone who uses Manor, newest first. A version is a tag on `main`. The root, server, web, desktop, contracts and client runtime packages carry the same number. The phone companion and the blobatar copy keep their own.

## Unreleased

- An agent that had been quiet for weeks answers again. Claude Code deletes a saved conversation after 30 days, and from then on every message to that agent failed at once, without a word in a DM. When Claude Code or Grok no longer has the conversation, Manor now starts a fresh session from its own record of the chat and answers the same message.
- The menus share one row: the same height and corners, an icon in front of each action, and a tick on the choice in use. That covers the Browser's menus and More panels, where a choice read Selected or Current, and the plus, model and branch menus under the message field, where the chosen row was filled.
- The New session and Recent sessions menus beside the Browser take the arrow keys, Home and End, as the other menus do. They and the Browser menu now put focus on their first row the first time they open too, not only from the second time on.
- While an agent works through its steps, only the turn that changed redraws. Every step used to redraw every message on screen, on the phone and on the Mac, a few times a second in a busy turn.
- Coming back to a chat after the connection dropped loads only what was added or changed meanwhile, on the phone and on the Mac. It used to download the whole conversation again, megabytes for a long one. After a restart of Manor on your Mac the first open still loads everything.
- On the Mac, opening a subagent's view again, or a chat in a second pane, asks only for what was added since. Each open used to download the whole thread.
- On the phone, the label next to the plus names who you mention while an agent is still answering, as on the Mac. It read as unknown for every draft during a running turn.
- On the phone, an answer typed on a question card stops at the 2,000 characters the Mac allows. A longer one made Send do nothing, without a word. A question you skipped on the Mac now reads Skipped on the phone, as it does there, and no longer the sentence meant for the agent.
- On the phone, what you type under Request changes stays when its card scrolls out of view or you leave the chat. The field used to come back open and empty, and a picked Your call choice was lost with it.
- On the phone, typing redraws only the composer. Every character used to redraw the whole chat screen, its header and its list with it.
- On the phone, a reply that streams in redraws only its own text. The header, the composer, the menu and the list under the chat used to redraw with every piece of text, in a DM too, where the reply shows only once it is whole. Scrolling and typing stay smooth while an agent writes.
- On the phone, the cards in a chat notice when the connection to your Mac drops or returns. A mail card that was already on screen kept its Send and Discard buttons live while offline.
- On the phone, a chat you went back from shows its unread dot when a reply lands in it, and a run that ends there waits for you instead of settling itself. Coming back to the app on the inbox no longer reloads the last chat you had open.
- The phone app loads a third of the code it did. It bundled every icon in the set, about 6,000, to draw 174.
- A DM's composer is one rounded row at the bottom, in an empty DM too: a plus, the message and send. It grows into the usual card once the message is longer than a line or carries an attachment. The model picker left it, because a DM runs on the model its agent's settings name. Auto no longer picks a model for a DM. A DM that still carries an earlier pick shows it in Agent settings, and choosing a model there replaces it.
- A rule you give an agent in chat, such as "write follow-ups in Dutch", goes into its notes, never its instructions. The reply shows "Updated its notes +1 line" with View, which opens the notes in Agent settings, and Undo, which puts the notes back unless they changed since. With memory off the agent keeps nothing and says so, and "Add to instructions" opens its Instructions page with the line ready for you to add.
- Agent settings open beside the agent's DM, from the Agent settings door or the face in the header. A short root holds the face, name, title, what it helps with and its model, with a page each for instructions, memory, skills, connectors, scheduled tasks and access, where subagents sit. Memory holds the conversation summary and the agent's notes, and Scheduled tasks is where you give the agent a schedule; both were separate doors beside the DM and now live here. The model field is the composer's picker, with Fast mode in it. Changes save as you make them, quietly unless a save fails. Session agents open the same settings in Settings → Agents, listed first. The long agent form is gone.
- Tool groups are gone. Every agent gets every built-in tool; connections stay per agent, and writes to outside services still ask you first.
- A new agent opens its DM with three or four question cards, then writes its own instructions from your answers, once. After that only you change them. Its first message greets you by name, says what it left out and makes a suggestion or asks a question about its job. Skipping every question still leaves instructions built from the form.
- New agent opens a short form over the workspace: a face, a name, what it should help with, and a model with effort. Create opens the agent's DM. A new agent starts with memory on. The onboarding's first agent uses the same form. The Role field is gone from creation.
- A persona's face now shows what her turn is doing. She tilts her head while she thinks, follows lines while she reads, melts into three dots while her answer streams in, dozes while she waits on a colleague, turns to you when she needs an answer, nods when she is done and shakes when a turn fails. Any other work keeps the eye loop she already had. Reduced motion and photo avatars show none of it. The phone shows it on the face behind the latest reply and in a DM's working line.
- Persona faces have a richer finish. The light on a face is now tinted from its own colour, small faces are drawn simpler with larger eyes, and in the dark theme a face stands on a glow in its colour, where its shadow could not be seen.
- After you push a branch, the Session panel shows the pull or merge request page your remote offers, one click away. It needs no sign in in Manor.
- A push that fails because this Mac is not signed in to the remote now says so and names the way out, instead of repeating Git's last line.
- The README says that agents use your own git and `gh` sign in.
- An agent's own `git push` over ssh now works with a key the macOS ssh agent holds, as it does in your Terminal.
- A new Session can work in a folder without making a project. On an empty install the chip reads Add folder and opens the folder picker. Folders stay in the list until you remove them, which keeps their Sessions. Projects' + menu turns a folder into a project with a thread. The picker no longer creates projects.

## 0.1.0, 2026-11-13

The first public version. Manor is source only for now, so you build the app yourself. See `README.md`.
