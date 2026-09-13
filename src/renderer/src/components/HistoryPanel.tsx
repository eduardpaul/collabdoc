import { useMemo, useState } from 'react'
import { diffChange } from '@core/history-diff'
import type { HistoryAuthor } from '@core/authors'
import type { HistoryEntry } from '@core/history'
import { authorCounts, filterHistory } from '@core/history'
import type { Checkpoint } from '@core/checkpoints'
import type { DocumentClient } from '../sync/DocumentClient'
import type { HistoryView } from '../sync/useHistory'
import { Button, TextInput } from './ui'
import { DiffBoard } from './DiffBoard'

export function HistoryPanel({
  client,
  history,
  youId,
  selectedId,
  onSelect,
  onView,
  onRestore,
  readOnly = false
}: {
  client: DocumentClient
  history: HistoryView
  youId: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  onView: (entry: HistoryEntry) => void
  onRestore: (entry: HistoryEntry) => void
  /** A guest whose host ended: viewing stays, restore and checkpoints go. */
  readOnly?: boolean
}): React.JSX.Element {
  const [authorId, setAuthorId] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [checkpointName, setCheckpointName] = useState('')
  const newestFirst = useMemo(() => [...history.entries].reverse(), [history.entries])
  const counts = useMemo(() => authorCounts(history.entries), [history.entries])
  const authors = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; color: string }>()
    for (const entry of history.entries) {
      if (!seen.has(entry.author.actorId)) {
        seen.set(entry.author.actorId, {
          id: entry.author.actorId,
          name: entry.author.actorId === youId ? 'You' : entry.author.name,
          color: entry.author.color
        })
      }
    }
    const list = [...seen.values()]
    list.sort((a, b) => {
      if (a.id === youId) return -1
      if (b.id === youId) return 1
      return a.name.localeCompare(b.name)
    })
    return list
  }, [history.entries, youId])

  // Checkpoints store an actorId; the name and colour come from that actor's commits.
  const authorOf = (actorId: string): HistoryAuthor =>
    history.entries.find((entry) => entry.author.actorId === actorId)?.author ?? {
      actorId,
      name: actorId === youId ? 'You' : 'Unknown',
      color: '#8a7d6d'
    }

  const visible = useMemo(
    () =>
      filterHistory(newestFirst, {
        actorId: authorId === 'all' ? undefined : authorId,
        query
      }),
    [newestFirst, authorId, query]
  )
  const selected = history.entries.find((entry) => entry.id === selectedId) ?? null
  const hunks = selected ? diffChange(client.doc, selected) : []
  const filterSum = [...counts.values()].reduce((n, c) => n + c, 0)

  return (
    <div className="history-panel" data-testid="history-panel">
      <p className="rail__lede">
        One entry per commit. Filter by author; {filterSum} across filters
        {filterSum === history.entries.length ? ' matches the total.' : '.'}
      </p>
      <div className="history-filters" role="group" aria-label="Filter by author">
        <button
          type="button"
          className={`chip ${authorId === 'all' ? 'is-on' : ''}`}
          onClick={() => setAuthorId('all')}
        >
          All {history.entries.length}
        </button>
        {authors.map((author) => (
          <button
            type="button"
            key={author.id}
            className={`chip ${authorId === author.id ? 'is-on' : ''}`}
            style={{ '--author-color': author.color } as React.CSSProperties}
            onClick={() => setAuthorId(author.id)}
          >
            {author.name} {counts.get(author.id) ?? 0}
          </button>
        ))}
      </div>
      <TextInput
        aria-label="Search history"
        placeholder="Search summaries"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {history.checkpoints.length ? (
        <ul className="history-pins">
          {history.checkpoints.map((cp) => (
            <CheckpointRow
              key={cp.id}
              checkpoint={cp}
              onView={() => onView(checkpointEntry(cp, authorOf(cp.actorId)))}
            />
          ))}
        </ul>
      ) : null}
      <ol className="history-list">
        {visible.length === 0 ? (
          <li className="empty">No commits match.</li>
        ) : (
          visible.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`history-row ${selectedId === entry.id ? 'is-selected' : ''}`}
                onClick={() => onSelect(entry.id === selectedId ? null : entry.id)}
              >
                <span className="history-dot" style={{ background: entry.author.color }} />
                <span>
                  <strong>{entry.author.actorId === youId ? 'You' : entry.author.name}</strong>
                  <span className="muted"> {formatTime(entry.timestamp)}</span>
                  <p>{entry.summary}</p>
                  {entry.message ? <p className="muted">{entry.message}</p> : null}
                </span>
              </button>
            </li>
          ))
        )}
      </ol>
      {selected ? (
        <div className="history-detail">
          <DiffBoard hunks={hunks} />
          <div className="history-detail__actions">
            <Button size="sm" onClick={() => onView(selected)}>
              View this version
            </Button>
            {readOnly ? null : (
              <Button size="sm" variant="primary" onClick={() => onRestore(selected)}>
                Restore
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {readOnly ? null : (
        <form
          className="checkpoint-form"
          onSubmit={(event) => {
            event.preventDefault()
            history.markCheckpoint(checkpointName)
            setCheckpointName('')
          }}
        >
          <TextInput
            aria-label="Checkpoint name"
            placeholder="Checkpoint name"
            value={checkpointName}
            onChange={(event) => setCheckpointName(event.target.value)}
          />
          <Button type="submit" size="sm">
            Mark checkpoint
          </Button>
        </form>
      )}
    </div>
  )
}

function CheckpointRow({
  checkpoint,
  onView
}: {
  checkpoint: Checkpoint
  onView: () => void
}): React.JSX.Element {
  return (
    <li>
      <button type="button" className="history-row history-row--pin" onClick={onView}>
        <span className="history-dot history-dot--pin" />
        <span>
          <strong>{checkpoint.name}</strong>
          <span className="muted"> {formatTime(checkpoint.at)}</span>
        </span>
      </button>
    </li>
  )
}

function checkpointEntry(cp: Checkpoint, author: HistoryAuthor): HistoryEntry {
  return {
    id: cp.id,
    peer: cp.actorId,
    counter: 0,
    length: 0,
    lamport: 0,
    timestamp: cp.at,
    message: `checkpoint: ${cp.name}`,
    summary: cp.name,
    details: [],
    added: 0,
    removed: 0,
    author,
    frontiers: cp.frontiers,
    parentFrontiers: [],
    blockIds: []
  }
}

function formatTime(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
