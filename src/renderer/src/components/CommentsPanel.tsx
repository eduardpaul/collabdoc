import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { threadMentions } from '@core/comments'
import type { CommentReply, CommentThread } from '@shared/types'
import type { CommentActionResult } from '../sync/comments-api'
import type { CommentsView } from '../sync/useComments'
import { Button, Select, TextArea } from './ui'

export type Participant = { id: string; handle: string; name: string; color: string }

/** A comment the user is about to write, from the selection or a block. */
export type CommentDraft = { blockId: string; start?: number; end?: number; quote: string }

type Filter = 'open' | 'resolved' | 'mine' | 'mentions'

export function CommentsPanel({
  comments,
  youId,
  youHandle,
  participants,
  selectedId,
  onSelect,
  onReveal,
  draft,
  onCloseDraft,
  onNotice,
  readOnly = false
}: {
  comments: CommentsView
  youId: string
  youHandle: string
  participants: Participant[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Scroll the editor to a thread's span. */
  onReveal: (id: string) => void
  draft: CommentDraft | null
  onCloseDraft: () => void
  onNotice: (message: string) => void
  readOnly?: boolean
}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('open')
  const [byActor, setByActor] = useState('all')
  const listRef = useRef<HTMLOListElement>(null)
  const { threads, unread, api, markRead } = comments

  const visible = useMemo(() => {
    return threads.filter((thread) => {
      if (byActor !== 'all' && !involves(thread, byActor)) return false
      switch (filter) {
        case 'open':
          return thread.status === 'open' && !thread.orphaned
        case 'resolved':
          return thread.status === 'resolved' || thread.orphaned === true
        case 'mine':
          return involves(thread, youId)
        case 'mentions':
          return youHandle ? threadMentions(thread, youHandle) : false
      }
    })
  }, [threads, filter, byActor, youId, youHandle])

  const counts = useMemo(
    () => ({
      open: threads.filter((t) => t.status === 'open' && !t.orphaned).length,
      resolved: threads.filter((t) => t.status === 'resolved' || t.orphaned).length
    }),
    [threads]
  )

  useEffect(() => {
    if (selectedId) markRead(selectedId)
  }, [selectedId, markRead])

  const run = (result: CommentActionResult): void => {
    if (!result.ok) onNotice(result.error)
  }

  // `]` / `[` step through the open threads while the panel has focus — the
  // editor keeps those keys for typing.
  const onKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== ']' && event.key !== '[') return
    const target = event.target as HTMLElement
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return
    const open = threads.filter((t) => t.status === 'open' && !t.orphaned)
    if (open.length === 0) return
    const at = open.findIndex((t) => t.id === selectedId)
    const step = event.key === ']' ? 1 : -1
    const next = open[(at + step + open.length) % open.length]
    event.preventDefault()
    onSelect(next.id)
    onReveal(next.id)
  }

  return (
    <div className="comments-panel" data-testid="comments-panel" onKeyDown={onKey}>
      {draft && api && !readOnly ? (
        <Composer
          draft={draft}
          onCancel={onCloseDraft}
          onSubmit={(body) => {
            const result = api.add({ ...draft, body })
            run(result)
            if (result.ok) {
              onCloseDraft()
              setFilter('open')
              onSelect(result.thread.id)
            }
          }}
        />
      ) : null}
      <div className="history-filters" role="group" aria-label="Filter comments">
        <FilterChip on={filter === 'open'} onClick={() => setFilter('open')}>
          Open {counts.open}
        </FilterChip>
        <FilterChip on={filter === 'resolved'} onClick={() => setFilter('resolved')}>
          Resolved / orphaned {counts.resolved}
        </FilterChip>
        <FilterChip on={filter === 'mine'} onClick={() => setFilter('mine')}>
          Mine
        </FilterChip>
        <FilterChip on={filter === 'mentions'} onClick={() => setFilter('mentions')}>
          Mentions me
        </FilterChip>
        <Select
          aria-label="By participant"
          value={byActor}
          onChange={(event) => setByActor(event.target.value)}
        >
          <option value="all">Everyone</option>
          {participants.map((person) => (
            <option key={person.id} value={person.id}>
              {person.id === youId ? 'You' : person.name}
            </option>
          ))}
        </Select>
      </div>
      <ol className="comment-list" ref={listRef} tabIndex={0} aria-label="Comment threads">
        {visible.length === 0 ? (
          <li className="empty">
            {threads.length === 0
              ? 'Select text and press Comment to start a thread.'
              : 'No threads match.'}
          </li>
        ) : (
          visible.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              youId={youId}
              participants={participants}
              selected={thread.id === selectedId}
              unread={unread.has(thread.id)}
              readOnly={readOnly || !api}
              onSelect={() => {
                onSelect(thread.id === selectedId ? null : thread.id)
                if (thread.id !== selectedId) onReveal(thread.id)
              }}
              onReply={(body) => {
                if (!api) return
                run(api.reply(thread.id, body))
                markRead(thread.id)
              }}
              onResolve={() => api && run(api.resolve(thread.id))}
              onReopen={() => api && run(api.reopen(thread.id))}
              onEdit={(body) => api && run(api.edit(thread.id, body))}
              onDelete={() => api && run(api.remove(thread.id))}
              onEditReply={(replyId, body) => api && run(api.editReply(thread.id, replyId, body))}
              onDeleteReply={(replyId) => api && run(api.removeReply(thread.id, replyId))}
            />
          ))
        )}
      </ol>
    </div>
  )
}

function involves(thread: CommentThread, actorId: string): boolean {
  return thread.author.id === actorId || thread.replies.some((r) => r.author.id === actorId)
}

function FilterChip({
  on,
  onClick,
  children
}: {
  on: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button type="button" className={`chip ${on ? 'is-on' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}

function Composer({
  draft,
  onSubmit,
  onCancel
}: {
  draft: CommentDraft
  onSubmit: (body: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [body, setBody] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <form
      className="comment-composer"
      data-testid="comment-composer"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(body)
      }}
    >
      <p className="comment-quote">{draft.start == null ? 'Whole block' : <q>{draft.quote}</q>}</p>
      <TextArea
        ref={ref}
        aria-label="New comment"
        placeholder="Comment… use @handle to mention someone"
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            onSubmit(body)
          }
          if (event.key === 'Escape') onCancel()
        }}
      />
      <div className="comment-actions">
        <Button type="submit" size="sm" variant="primary" disabled={!body.trim()}>
          Comment
        </Button>
        <Button type="button" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function ThreadCard({
  thread,
  youId,
  participants,
  selected,
  unread,
  readOnly,
  onSelect,
  onReply,
  onResolve,
  onReopen,
  onEdit,
  onDelete,
  onEditReply,
  onDeleteReply
}: {
  thread: CommentThread
  youId: string
  participants: Participant[]
  selected: boolean
  unread: boolean
  readOnly: boolean
  onSelect: () => void
  onReply: (body: string) => void
  onResolve: () => void
  onReopen: () => void
  onEdit: (body: string) => void
  onDelete: () => void
  onEditReply: (replyId: string, body: string) => void
  onDeleteReply: (replyId: string) => void
}): React.JSX.Element {
  const [reply, setReply] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const mine = thread.author.id === youId
  const state = thread.orphaned ? 'orphaned' : thread.status
  return (
    <li
      className={`comment-card ${selected ? 'is-selected' : ''} is-${state}`}
      data-testid="comment-card"
      data-thread={thread.id}
      style={{ '--thread-color': thread.author.color } as React.CSSProperties}
    >
      <button type="button" className="comment-card__head" onClick={onSelect}>
        {unread ? <span className="comment-unread" aria-label="Unread replies" /> : null}
        <AuthorChip author={thread.author} youId={youId} />
        <span className="muted">{formatTime(thread.createdAt)}</span>
        <span className={`chip chip--mute comment-state`}>{state}</span>
      </button>
      {thread.quote && !thread.whole ? (
        <p className="comment-quote">
          <q>{thread.quote}</q>
        </p>
      ) : null}
      {editing === thread.id ? (
        <EditBox
          initial={thread.body}
          onSave={(body) => {
            onEdit(body)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <p className="comment-body">
          {thread.deleted ? (
            <span className="muted">(deleted)</span>
          ) : (
            <Mentions text={thread.body} participants={participants} />
          )}
        </p>
      )}
      {mine && !readOnly && !thread.deleted && editing !== thread.id ? (
        <div className="comment-own">
          <button type="button" className="linkish" onClick={() => setEditing(thread.id)}>
            Edit
          </button>
          <button type="button" className="linkish" onClick={onDelete}>
            Delete
          </button>
        </div>
      ) : null}
      {selected ? (
        <>
          {thread.replies.length ? (
            <ul className="comment-replies">
              {thread.replies.map((item) => (
                <ReplyRow
                  key={item.id}
                  reply={item}
                  youId={youId}
                  participants={participants}
                  readOnly={readOnly}
                  editing={editing === item.id}
                  onStartEdit={() => setEditing(item.id)}
                  onSave={(body) => {
                    onEditReply(item.id, body)
                    setEditing(null)
                  }}
                  onCancel={() => setEditing(null)}
                  onDelete={() => onDeleteReply(item.id)}
                />
              ))}
            </ul>
          ) : null}
          {readOnly ? null : (
            <form
              className="comment-reply-box"
              onSubmit={(event) => {
                event.preventDefault()
                if (!reply.trim()) return
                onReply(reply)
                setReply('')
              }}
            >
              <TextArea
                aria-label="Reply"
                placeholder="Reply… @handle to mention"
                rows={2}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    if (!reply.trim()) return
                    onReply(reply)
                    setReply('')
                  }
                }}
              />
              <div className="comment-actions">
                <Button type="submit" size="sm" disabled={!reply.trim()}>
                  Reply
                </Button>
                {thread.status === 'open' ? (
                  <Button type="button" size="sm" variant="primary" onClick={onResolve}>
                    Resolve
                  </Button>
                ) : (
                  <Button type="button" size="sm" onClick={onReopen}>
                    Reopen
                  </Button>
                )}
              </div>
            </form>
          )}
        </>
      ) : thread.replies.length ? (
        <p className="muted comment-count">
          {thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}
        </p>
      ) : null}
    </li>
  )
}

function ReplyRow({
  reply,
  youId,
  participants,
  readOnly,
  editing,
  onStartEdit,
  onSave,
  onCancel,
  onDelete
}: {
  reply: CommentReply
  youId: string
  participants: Participant[]
  readOnly: boolean
  editing: boolean
  onStartEdit: () => void
  onSave: (body: string) => void
  onCancel: () => void
  onDelete: () => void
}): React.JSX.Element {
  const mine = reply.author.id === youId
  return (
    <li
      className="comment-reply"
      style={{ '--thread-color': reply.author.color } as React.CSSProperties}
    >
      <div className="comment-card__head">
        <AuthorChip author={reply.author} youId={youId} />
        <span className="muted">{formatTime(reply.at)}</span>
      </div>
      {editing ? (
        <EditBox initial={reply.body} onSave={onSave} onCancel={onCancel} />
      ) : (
        <p className="comment-body">
          {reply.deleted ? (
            <span className="muted">(deleted)</span>
          ) : (
            <Mentions text={reply.body} participants={participants} />
          )}
        </p>
      )}
      {mine && !readOnly && !reply.deleted && !editing ? (
        <div className="comment-own">
          <button type="button" className="linkish" onClick={onStartEdit}>
            Edit
          </button>
          <button type="button" className="linkish" onClick={onDelete}>
            Delete
          </button>
        </div>
      ) : null}
    </li>
  )
}

function EditBox({
  initial,
  onSave,
  onCancel
}: {
  initial: string
  onSave: (body: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [body, setBody] = useState(initial)
  return (
    <form
      className="comment-reply-box"
      onSubmit={(event) => {
        event.preventDefault()
        if (body.trim()) onSave(body)
      }}
    >
      <TextArea
        aria-label="Edit comment"
        rows={2}
        value={body}
        autoFocus
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      />
      <div className="comment-actions">
        <Button type="submit" size="sm" variant="primary" disabled={!body.trim()}>
          Save
        </Button>
        <Button type="button" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function AuthorChip({
  author,
  youId
}: {
  author: CommentThread['author']
  youId: string
}): React.JSX.Element {
  return (
    <span className="comment-author">
      <span className="history-dot" style={{ background: author.color }} />
      <strong>{author.id === youId ? 'You' : author.name}</strong>
      {author.role === 'agent' ? <span className="role-badge">agent</span> : null}
    </span>
  )
}

const MENTION = /(@[a-z0-9_-]{2,20})/gi

/** `@handle` becomes a chip when it names a participant; anything else stays text. */
export function Mentions({
  text,
  participants
}: {
  text: string
  participants: Participant[]
}): React.JSX.Element {
  const known = new Map(participants.map((p) => [p.handle.toLowerCase(), p]))
  const parts = text.split(MENTION)
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const person = known.get(part.slice(1).toLowerCase())
          if (person) {
            return (
              <span
                key={i}
                className="mention-chip"
                style={{ '--thread-color': person.color } as React.CSSProperties}
                data-testid="mention-chip"
              >
                {part}
              </span>
            )
          }
        }
        return <span key={i}>{part}</span>
      })}
    </>
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
