# 07 · Identity, presence, remote cursors, participant list

**Phase:** 2 · **Depends on:** 03 · **Status:** not started

## Summary

Give each participant — human, guest, agent — an identity (name, color, role) that is attached to their Loro peer, broadcast as ephemeral presence (cursor, selection, claimed blocks), and shown in the "In this session" list and as remote carets in the editor.

## Current state (collabdoc)

- `Workspace.tsx` builds `participants` from `state.agents.filter(invited)` plus a hard-coded "Waiting for peers" row when share is active. There is no user identity; the human is always "You".
- No cursors, no presence transport.

## Reference (lorocollab)

- `core/session.ts` — `EphemeralPayload { anchor, focus, user: { name, color, actorId, role }, claim }`, `set_presence` / `get_presence` tools, claim expiry.
- `client/extensions/loro-collab.ts` — `LoroEphemeralCursorPlugin(presence, { user })` with the note that `user` is passed through verbatim so extra fields (`actorId`, `role`) reach agents.
- `shared/actors.ts` — `AGENT_COLORS`, `agentColor(index)`.

## Review before adopting

- lorocollab identity is a constant (`HUMAN_ACTOR`). CollabDoc needs a user profile in settings (name, color, optional avatar initial) persisted in `userData`, with a first-run prompt (skippable → "You").
- `EphemeralStore(30_000)` timeout is shared by hub and sessions; presence should expire at 15 s with heartbeats every 5 s so a crashed guest disappears quickly, while claims keep their own `until`.
- Cursor decorations use `loro-prosemirror`'s default rendering; restyle with the app's CSS variables and add a name label that fades after 2 s of inactivity.
- `get_presence` results mark role as optional and say "do not assume human". Keep that.

## Design

- `UserProfile { userId (stable uuid per install), name, color }` in `userData/profile.json`; editable in Settings → new "You" tab.
- Each `DocumentClient` publishes `user` with `{ name, color, actorId: userId, role: "human" }`. Agents publish `role: "agent"`. Guests (08) publish their own profile.
- Participant list = union of (a) presence entries seen in the last 15 s and (b) invited agents that are idle (so an invited but quiet agent still shows). Rows show name, role, "working" / "typing in ¶3" status, and for agents the invite/remove control.
- Remote carets: colored caret + selection highlight + name label; clicking a participant scrolls to their cursor.
- Claims (advisory) render as a faint colored outline around the claimed block with the claimer's name in the gutter.
- Presence is ephemeral only: never in the Loro document, never in history, never saved.

## Acceptance criteria

- [ ] AC-07.1 On first launch the user is asked for a display name (skippable); the chosen name/color persist across restarts and are editable in Settings.
- [ ] AC-07.2 Two participants (renderer + harness peer, or host + guest after 08) each see the other's caret with the correct color and name label at the correct document position, updating within 100 ms of movement.
- [ ] AC-07.3 A participant that stops sending presence disappears from the list and the editor within 15 s; reconnection restores them without duplicates.
- [ ] AC-07.4 The "In this session" list shows: the local user, connected guests, invited agents; each with role label and live status (`idle`, `working`, `typing in <block>`); the hard-coded "Waiting for peers" row is removed.
- [ ] AC-07.5 Agent `get_presence` returns humans and agents with `role` set only when the peer published it; a peer without a `user` payload appears as `{ peerId, role: undefined }`.
- [ ] AC-07.6 Claimed blocks show an outline and the claimer's name; the outline disappears when `until` passes or the claimer clears it.
- [ ] AC-07.7 Presence data never appears in `listHistory`, in the saved `.collabdoc`, or in the Markdown export (assert on all three).
- [ ] AC-07.8 Presence traffic for one active participant stays under 2 KB/s (throttle cursor updates to ≤ 20/s).

## Out of scope

Avatars/images; "follow this user" mode; audio/video.
