# 05 · Change history, attribution, checkpoints, and time travel

**Phase:** 1 · **Depends on:** 03 · **Status:** not started

## Summary

Surface Loro's change log as a History panel: every change grouped per commit, attributed to the human, guest, or agent that made it, with a word-level diff, filter by author, named checkpoints, and read-only time travel with "restore this version". This is the "strictly version-controlled and attributed" promise from the Scope.

## Current state (collabdoc)

- The Activity tab in the rail lists reducer-generated strings (`Created a new document`, `Saved …`) in memory only.

## Reference (lorocollab)

- `core/history.ts` — `listHistory`, `describeChange`, `diffChange` (fork to parent frontiers, diff block texts with `diff`'s `diffWordsWithSpace`), `readAuthors`, `normalizeTimestamp`.
- `client/components/HistoryPanel.tsx` — `HistoryPanel` (list + author filter chips) and `DiffBoard` (hunks with `+/−` parts).
- `client/App.tsx` — `HISTORY_SETTLE_MS = 400` debounce; the comment explains why history is not recomputed per keystroke.
- `core/history.test.ts`.

## Review before adopting

- `listHistory` is O(all changes) and `diffChange` forks the document per selected change. Fine for a POC; for CollabDoc add an incremental index: cache `HistoryEntry[]` per hub and append on new commits (subscribe with `doc.subscribe`), and cache the last N diffs.
- Change granularity: Loro merges consecutive ops from one peer into one change unless a commit boundary is forced. Typing a paragraph shows as one entry — good. Agent tool calls commit individually (02) — also good. Define the rule: **one history entry = one commit**, and the human's commits are cut on 1 s idle or block change (configure `LoroSyncPlugin` / manual `doc.commit()` in the client).
- `unknownAuthor(peer)` labels unknown peers with the peer id. Keep; never guess a role.
- Time travel does not exist in lorocollab; `doc.checkout(frontiers)` puts a Loro doc into detached mode — do it on a **fork**, never on the hub doc.

## Design

- Rail gets a third tab **History** (rename the existing "Activity" tab stays for 19). Entries newest-first: author chip (color from `authors`), time, summary (`+12 −3 "first words…"`), and the tool name/`message` for agent commits.
- Author filter chips (All, You, each guest, each agent). Search box filters by summary text.
- Selecting an entry shows the diff in a panel under the editor or in the rail (reuse the `DiffBoard` behaviour).
- **Checkpoints**: "Mark checkpoint" writes `{ name, frontiers, actorId, at }` into a `checkpoints` root list. Checkpoints appear as pinned rows and in the export menu.
- **Time travel**: "View this version" forks the client doc, `checkout(frontiers)`, and renders it in a read-only editor overlay with a banner ("Viewing version from 14:02 by Reviewer · Restore · Close"). "Restore" applies the inverse as a *new* commit by the current user (never rewrites history): compute the block-level diff and apply it through the user's `DocumentSession` so it is attributed and undoable.
- Attribution of agent edits inside the editor: a subtle left-gutter color bar per block for the last author (toggle in the toolbar), computed from Loro `getCursor`/change spans; if too costly, start with block-level "last edited by" from the history index.
- Ephemeral/presence changes never appear in history.

## Acceptance criteria

- [ ] AC-05.1 The History tab lists one entry per commit with author name and color, timestamp (local time), and a summary with added/removed counts; entries appear within 500 ms after typing pauses.
- [ ] AC-05.2 Entries made by a guest (08) or an agent (12) are attributed to that participant's name/color, taken from the `authors` map, even after the file is closed and reopened (AC-04.2).
- [ ] AC-05.3 Filtering by author shows only that author's entries; the count of entries across all filters equals the total.
- [ ] AC-05.4 Selecting an entry shows a word-level diff per touched block (`add`, `remove`, `change`, plus context `same` blocks), and the diff of a 2 000-block document renders in under 300 ms.
- [ ] AC-05.5 "Mark checkpoint" with a name creates a pinned entry; checkpoints sync to guests and survive save/reopen.
- [ ] AC-05.6 "View this version" opens a read-only view of the document at that commit; the live editor is not modified; closing returns to the live state with the caret preserved.
- [ ] AC-05.7 "Restore" from a viewed version produces exactly one new commit attributed to the current user whose resulting text equals the viewed version; history still contains everything that came after the restored point; the restore can be undone with `Mod+Z`.
- [ ] AC-05.8 Human typing is grouped into commits by ≤ 1 s idle or block switch; an agent tool call is always its own commit with `message` equal to the tool summary (e.g. `replace_text in b_x: "foo" → "bar"`).
- [ ] AC-05.9 The gutter attribution toggle shows, per block, the color of the last author; it updates live as guests/agents edit.
- [ ] AC-05.10 History computation is incremental: appending 1 000 commits to a document with 10 000 existing commits takes under 1 s total in a unit benchmark, and does not re-walk all changes per commit.

## Out of scope

Branching/merging alternate drafts; per-character blame tooltip; exporting history to a file.

## Open questions

- Whether "Restore" should also restore comments state at that version. Default: no — comments are a sidecar with their own lifecycle.
