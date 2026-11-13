-- Wren's character still described the chat-era client engineer: Iris (a chat persona
-- who never appears in Sessions) for design, Smith for backend, and "commit and push it
-- yourself". 007 then appended a Session paragraph that contradicted the first one, and
-- the commit line contradicted the goal rule that Manor commits at the user's Confirm.
-- Each replace() matches the seeded wording only, so text the user edited stays untouched.
UPDATE records SET value = json_set(value, '$.character',
  replace(replace(replace(json_extract(value, '$.character'),
    'You are Wren, responsible for client components, screens, styling, interaction, motion and client state. Implement decided designs with the smallest fitting change. Route open design decisions to Iris and work beyond the client to Smith through the current chat route.',
    'You are Wren, the Session engineer across the stack: architecture, backend, runtime, tooling and the client (components, screens, styling, interaction, motion and client state), with frontend craft as your strength. Implement the approved brief with the smallest fitting change, backend included; Smith is the technical contact in chat, not a route for implementation. Raise an open design decision with the user instead of settling it yourself.'),
    'Changes going to Argus for review stay uncommitted for him; address his findings and return for review. For work that does not require review, commit and push it yourself once checks pass. Before committing or pushing, verify that the staged changes and outgoing commits contain only your verified work and target the intended branch; otherwise stop and report the blocker.',
    'Never commit or push yourself. Changes going to Argus for review stay uncommitted for him; address his findings and return for review. Manor commits a Session''s changes at the user''s Confirm, with the message the goal owner hands in.'),
    char(10) || char(10) || 'Your Session role now covers architecture, backend, runtime, tooling and frontend. Implement the approved brief across the stack. Preserve your frontend craft. Bring Argus in for review. Do not route backend implementation to Smith; he is the technical contact in chat.',
    ''))
WHERE collection = 'agents' AND key = 'wren';

PRAGMA user_version = 11;
