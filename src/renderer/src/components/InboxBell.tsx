import { useEffect, useRef, useState } from 'react'
import type { InboxEntry } from '@shared/types'
import { Button } from './ui'

/**
 * The person's inbox (10): mention requests addressed to them, newest
 * first, with jump-to and mark-read. Per install, never synced.
 */
export function InboxBell({
  entries,
  unread,
  onOpen,
  onMarkRead
}: {
  entries: InboxEntry[]
  unread: number
  onOpen: (entry: InboxEntry) => void
  onMarkRead: (ids: string[] | 'all') => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="inbox" ref={root}>
      <button
        type="button"
        className={`inbox__bell ${unread ? 'has-unread' : ''}`}
        aria-label={unread ? `Inbox, ${unread} unread` : 'Inbox'}
        aria-expanded={open}
        data-testid="inbox-bell"
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {unread ? (
          <span className="inbox__badge" data-testid="inbox-badge">
            {unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="inbox__panel" role="dialog" aria-label="Inbox" data-testid="inbox-panel">
          <header>
            <strong>Inbox</strong>
            {entries.some((e) => !e.read) ? (
              <Button size="sm" variant="ghost" onClick={() => onMarkRead('all')}>
                Mark all read
              </Button>
            ) : null}
          </header>
          {entries.length === 0 ? (
            <p className="empty">Mentions of you land here — from anyone, in any document.</p>
          ) : (
            <ol className="inbox__list">
              {entries.map((entry) => (
                <li key={entry.id} className={entry.read ? '' : 'is-unread'}>
                  <button
                    type="button"
                    className="inbox__item"
                    onClick={() => {
                      onOpen(entry)
                      setOpen(false)
                    }}
                  >
                    <span className="history-dot" style={{ background: entry.from.color }} />
                    <span>
                      <strong>{entry.from.name}</strong>
                      <span className="muted"> · {entry.docTitle || 'Untitled'}</span>
                      {entry.threadId ? <span className="muted"> · comment</span> : null}
                      <p>{entry.text}</p>
                      <span className="muted">{formatTime(entry.at)}</span>
                    </span>
                  </button>
                  {entry.read ? null : (
                    <button
                      type="button"
                      className="linkish"
                      aria-label="Mark read"
                      onClick={() => onMarkRead([entry.id])}
                    >
                      Mark read
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  )
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
