import { useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryEntry } from '@core/history'
import type { MentionState } from '@shared/types'
import { CommentsPanel, type CommentDraft } from '../components/CommentsPanel'
import { DocumentEditor } from '../components/DocumentEditor'
import { HistoryPanel } from '../components/HistoryPanel'
import { InboxBell } from '../components/InboxBell'
import { FileMenu } from '../components/FileMenu'
import { Button, Icon, StatusDot, TextArea, TextInput } from '../components/ui'
import { hostLabel } from '../lib/host'
import { useAppState } from '../state/AppState'
import { aiReady, backendLabel } from '../state/selectors'
import { useSessionActions } from '../state/useSessionActions'
import { useComments } from '../sync/useComments'
import { useDocumentClient } from '../sync/useDocumentClient'
import { useHistory } from '../sync/useHistory'
import { useMentions, type AgentDispatch } from '../sync/useMentions'
import { usePresence } from '../sync/usePresence'
import type { Agent } from '../types'

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function Workspace(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const actions = useSessionActions()
  const session = state.session
  const client = useDocumentClient(session?.id ?? '')
  const history = useHistory(client)
  const comments = useComments(client, state.profile.userId)
  const [selectedThread, setSelectedThread] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null)
  const revealRef = useRef<((threadId: string) => void) | null>(null)
  const chipStateRef = useRef<((requestId: string, state: MentionState) => boolean) | null>(null)
  const [ask, setAsk] = useState('')
  const [blockMarkdown, setBlockMarkdown] = useState('')
  const [selectedHistory, setSelectedHistory] = useState<string | null>(null)
  const [travel, setTravel] = useState<HistoryEntry | null>(null)
  const [restoreTo, setRestoreTo] = useState<HistoryEntry | null>(null)
  const ready = aiReady(state)

  useEffect(() => {
    if (!session) {
      return
    }
    const dirty = session.dirty ? '• ' : ''
    document.title = `${dirty}${session.title} · CollabDoc`
    return () => {
      document.title = 'CollabDoc'
    }
  }, [session])

  useEffect(() => {
    let narrow = window.innerWidth < 860
    if (narrow) {
      dispatch({ type: 'collapse-chrome' })
    }
    const onResize = (): void => {
      const next = window.innerWidth < 860
      if (next && !narrow) {
        dispatch({ type: 'collapse-chrome' })
      }
      narrow = next
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [dispatch])

  const presence = usePresence(client)
  const participants = useMemo(
    () =>
      presence.people.map((row) => ({
        id: row.id,
        handle: row.handle,
        name: row.name,
        color: row.color
      })),
    [presence.people]
  )

  // Agent requests run through the agent actions; the chip follows `status`.
  const agentDispatch = useMemo<AgentDispatch>(
    () => ({
      invoke: (target, instruction, context) => {
        const agent = state.agents.find((a) => a.id === target.id && a.invited)
        if (!agent) {
          // Every participant runs their own agents: another person's agent shows up in the
          // picker (it edited here), but only its owner can ask it or stop it.
          const mine = state.agents.some((a) => a.id === target.id)
          dispatch({
            type: 'notice',
            message: mine
              ? `${target.label} is no longer in this document.`
              : `${target.label} belongs to another participant — only they can ask it.`
          })
          return false
        }
        return actions.askAgent(agent, instruction, {
          kind: 'mention',
          context: {
            blockId: context.blockId,
            threadId: context.threadId,
            requestId: context.requestId
          }
        })
      },
      working: new Set(state.agents.filter((a) => a.status !== 'idle').map((a) => a.id))
    }),
    // askAgent reads state through its own closure each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.agents, dispatch]
  )
  const me = useMemo(
    () => ({
      id: state.profile.userId,
      name: state.profile.name,
      color: state.profile.color,
      handle: presence.localHandle
    }),
    [state.profile, presence.localHandle]
  )
  const mentions = useMentions({
    client,
    docTitle: session?.title ?? '',
    me,
    people: presence.people,
    agents: agentDispatch,
    authorOf: (blockId) => {
      const author = history.index?.lastAuthor(blockId)
      return author ? { id: author.actorId, name: author.name, color: author.color } : undefined
    },
    setChip: (requestId, state) => chipStateRef.current?.(requestId, state) ?? false
  })

  useEffect(() => {
    if (presence.handleNotice) {
      dispatch({ type: 'notice', message: presence.handleNotice })
    }
  }, [dispatch, presence.handleNotice])

  if (!session) {
    return null
  }

  const runAsk = (agent: Agent): void => {
    actions.askAgent(agent, ask)
    setAsk('')
  }

  return (
    <div
      className={`workspace ${state.leftCollapsed ? 'is-left-collapsed' : ''} ${state.rightCollapsed ? 'is-right-collapsed' : ''}`}
      data-screen="workspace"
    >
      <header className="topbar">
        <div className="topbar__left">
          <Button variant="ghost" size="sm" onClick={actions.goHome} aria-label="Back to documents">
            <Icon name="home" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatch({ type: 'toggle-left' })}
            aria-label="Toggle sidebar"
          >
            <Icon name="chevron" />
          </Button>
          <div className="topbar__title">
            <strong>{session.title}</strong>
            <span className="muted">
              {session.dirty
                ? 'Unsaved'
                : (session.path ?? (session.isDraft ? 'Draft' : 'Not saved'))}{' '}
              · {hostLabel()}
            </span>
          </div>
        </div>
        <div className="topbar__right">
          <InboxBell
            entries={mentions.inbox}
            unread={mentions.unread}
            onMarkRead={mentions.markRead}
            onOpen={(entry) => {
              mentions.markRead([entry.id])
              if (entry.docId !== session.id) {
                void actions.openRecent(entry.docId)
                return
              }
              if (entry.threadId) {
                setSelectedThread(entry.threadId)
                dispatch({ type: 'set-right-tab', tab: 'comments' })
                revealRef.current?.(entry.threadId)
              } else if (entry.blockId) {
                presence.scrollTo(entry.blockId)
              }
            }}
          />
          <button
            type="button"
            className={`ai-indicator ${ready ? 'is-ready' : ''}`}
            onClick={() => dispatch({ type: 'open-settings' })}
          >
            <StatusDot tone={ready ? 'live' : 'off'} />
            {ready ? 'AI ready' : 'AI off'}
          </button>
          <Button
            size="sm"
            variant={session.share.active ? 'accent' : 'secondary'}
            onClick={() => dispatch({ type: 'set-share-open', open: true })}
          >
            <Icon name="share" />
            {session.share.active ? session.share.code : 'Share'}
          </Button>
          <Button size="sm" onClick={() => void actions.saveDocument()}>
            Save
          </Button>
          <FileMenu />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dispatch({ type: 'open-settings' })}
            aria-label="Settings"
          >
            <Icon name="settings" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatch({ type: 'toggle-right' })}
            aria-label="Toggle agents"
          >
            <Icon name="spark" />
          </Button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar__section">
          <h2>Documents</h2>
          <Button size="sm" variant="ghost" onClick={actions.newDocument}>
            <Icon name="plus" /> New
          </Button>
        </div>
        <ul className="sidebar__list">
          <li>
            <button type="button" className="nav-row is-active">
              <Icon name="file" />
              <span>
                <strong>{session.title}</strong>
                <span className="muted">{session.dirty ? 'Editing' : 'Open'}</span>
              </span>
            </button>
          </li>
          {state.recents
            .filter((doc) => doc.id !== session.id)
            .slice(0, 8)
            .map((doc) => (
              <li key={doc.id}>
                <button
                  type="button"
                  className="nav-row"
                  onClick={() => void actions.openRecent(doc.id)}
                >
                  <Icon name="file" />
                  <span>
                    <strong>{doc.title}</strong>
                    <span className="muted">{doc.path ? 'On disk' : 'Local draft'}</span>
                  </span>
                </button>
              </li>
            ))}
        </ul>
        <div className="sidebar__section">
          <h2>In this session</h2>
        </div>
        <ul className="sidebar__list" data-testid="session-list">
          {presence.rows.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                className={`nav-row kind-${person.kind}`}
                disabled={!person.cursorBlockId}
                onClick={() => person.cursorBlockId && presence.scrollTo(person.cursorBlockId)}
              >
                <StatusDot
                  tone={person.status === 'working' ? 'work' : person.online ? 'live' : 'off'}
                />
                <span>
                  <strong>
                    {person.name} <span className="handle-tag">@{person.handle}</span>
                  </strong>
                  <span className="muted">
                    {person.kind === 'you' ? 'You' : person.role === 'agent' ? 'Agent' : 'Guest'} ·{' '}
                    {person.status}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="editor">
        {client ? (
          <>
            {session.share.hostEnded ? (
              <div className="host-ended" data-testid="host-ended">
                <p>Host ended the session · Save a copy to keep working.</p>
                <Button size="sm" onClick={() => void actions.saveDocument()}>
                  Save a copy
                </Button>
                <Button size="sm" onClick={() => void actions.forkDocument()}>
                  Fork as my own document
                </Button>
              </div>
            ) : null}
            <DocumentEditor
              key={session.id}
              client={client}
              readOnly={session.share.readOnly}
              history={history}
              travel={travel}
              restoreTo={restoreTo}
              onCloseTravel={() => setTravel(null)}
              onRestored={() => setRestoreTo(null)}
              comments={comments}
              selectedThread={selectedThread}
              onSelectThread={(id) => {
                setSelectedThread(id)
                dispatch({ type: 'set-right-tab', tab: 'comments' })
              }}
              onDraftComment={(draft) => {
                setCommentDraft(draft)
                dispatch({ type: 'set-right-tab', tab: 'comments' })
              }}
              revealRef={revealRef}
              people={presence.people}
              onSendMention={mentions.send}
              mentionAutoSendSeconds={state.mentionAutoSendSeconds}
              chipStateRef={chipStateRef}
              onNotice={(message) => dispatch({ type: 'notice', message })}
              onMarkdown={setBlockMarkdown}
              title={
                <TextInput
                  className="page__title"
                  value={session.title}
                  aria-label="Document title"
                  onChange={(event) => {
                    dispatch({ type: 'set-title', title: event.target.value })
                    client.setTitle(event.target.value)
                  }}
                />
              }
            />
          </>
        ) : (
          <div className="editor__connecting" data-testid="editor-connecting">
            <p className="muted">Connecting to the document…</p>
          </div>
        )}
      </main>

      <aside className="rail">
        <div className="tabs tabs--rail" role="tablist">
          <button
            type="button"
            className={`tabs__btn ${state.rightTab === 'agents' ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'set-right-tab', tab: 'agents' })}
          >
            Agents
          </button>
          <button
            type="button"
            className={`tabs__btn ${state.rightTab === 'comments' ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'set-right-tab', tab: 'comments' })}
            data-testid="tab-comments"
          >
            Comments
            {comments.unread.size ? (
              <span className="tabs__badge" aria-label={`${comments.unread.size} unread`}>
                {comments.unread.size}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={`tabs__btn ${state.rightTab === 'history' ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'set-right-tab', tab: 'history' })}
          >
            History
          </button>
          <button
            type="button"
            className={`tabs__btn ${state.rightTab === 'activity' ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'set-right-tab', tab: 'activity' })}
          >
            Activity
          </button>
          <button
            type="button"
            className={`tabs__btn ${state.rightTab === 'markdown' ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'set-right-tab', tab: 'markdown' })}
          >
            Markdown
          </button>
        </div>

        {state.rightTab === 'agents' ? (
          <div className="rail__body">
            <p className="rail__lede">
              Agents are participants. Invite them into this document, then ask them to draft or
              review.
            </p>
            <ul className="agent-list">
              {state.agents.map((agent) => {
                const lastRun = state.runs.find((run) => run.agentId === agent.id)
                // The status flips to queued the moment the person asks; the run record follows.
                const live =
                  agent.status !== 'idle' ||
                  (lastRun && (lastRun.status === 'queued' || lastRun.status === 'working'))
                return (
                  <li key={agent.id} className={`agent-card ${agent.invited ? 'is-invited' : ''}`}>
                    <header>
                      <span className={`role-badge role-badge--${agent.role}`}>{agent.role}</span>
                      <strong style={{ color: agent.color }}>{agent.name}</strong>
                      <StatusDot
                        tone={
                          agent.status === 'working'
                            ? 'work'
                            : agent.status === 'queued'
                              ? 'idle'
                              : agent.invited
                                ? 'live'
                                : 'off'
                        }
                      />
                    </header>
                    <p>{agent.persona}</p>
                    <div className="chips">
                      {agent.skills.map((skill) => (
                        <span key={skill} className="chip">
                          {skill}
                        </span>
                      ))}
                      <span className="chip chip--mute" title="Where this agent runs">
                        {backendLabel(state, agent)}
                      </span>
                    </div>
                    {!lastRun && agent.status === 'queued' ? (
                      <p className="muted agent-card__run">Queued</p>
                    ) : null}
                    {lastRun ? (
                      <p className="muted agent-card__run">
                        {live
                          ? `${lastRun.status === 'queued' ? 'Queued' : 'Working'} · ${lastRun.steps.length} tool call${lastRun.steps.length === 1 ? '' : 's'}${
                              lastRun.transcript.length
                                ? ` · ${lastRun.transcript[lastRun.transcript.length - 1].slice(0, 120)}`
                                : ''
                            }`
                          : lastRun.status === 'done'
                            ? [
                                'Done',
                                `${lastRun.writes} edit${lastRun.writes === 1 ? '' : 's'}`,
                                lastRun.summary.slice(0, 160)
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            : `${lastRun.status === 'cancelled' ? 'Cancelled' : lastRun.status === 'limit' ? 'Stopped' : 'Failed'}${
                                lastRun.error ? ` · ${lastRun.error.message}` : ''
                              }`}
                      </p>
                    ) : null}
                    {lastRun?.error?.stderrTail.length ? (
                      <details className="agent-card__stderr">
                        <summary className="muted">Last lines from the CLI</summary>
                        <pre>{lastRun.error.stderrTail.join('\n')}</pre>
                      </details>
                    ) : null}
                    <div className="agent-card__actions">
                      <Button
                        size="sm"
                        variant={agent.invited ? 'secondary' : 'primary'}
                        onClick={() => {
                          if (agent.invited) {
                            void window.api?.agents.cancelAgent({
                              agentId: agent.id,
                              docId: session.id
                            })
                          }
                          dispatch({
                            type: 'update-agent',
                            id: agent.id,
                            patch: { invited: !agent.invited }
                          })
                        }}
                      >
                        {agent.invited ? 'Remove from session' : 'Invite'}
                      </Button>
                      {live ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={!lastRun}
                          onClick={() => lastRun && actions.cancelRun(lastRun.runId)}
                        >
                          Cancel
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => runAsk(agent)}>
                          {agent.role === 'writer' ? 'Ask to draft' : 'Ask to review'}
                        </Button>
                      )}
                      {lastRun?.error?.kind === 'auth' ||
                      lastRun?.error?.kind === 'not_available' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void actions.refreshBackends()
                            dispatch({ type: 'open-settings', tab: 'backends' })
                          }}
                        >
                          Re-check auth
                        </Button>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
            <form
              className="ask-box"
              onSubmit={(event) => {
                event.preventDefault()
                const invited = state.agents.find((agent) => agent.invited) ?? state.agents[0]
                if (!invited) {
                  dispatch({ type: 'open-settings', tab: 'agents' })
                  return
                }
                runAsk(invited)
              }}
            >
              <label htmlFor="ask-agent">Ask an invited agent</label>
              <TextArea
                id="ask-agent"
                rows={3}
                value={ask}
                placeholder={
                  ready
                    ? 'e.g. Expand the second section in a calmer voice'
                    : 'Install and sign in to a CLI agent (Claude Code, grok…) to enable this'
                }
                onChange={(event) => setAsk(event.target.value)}
              />
              <Button type="submit" variant="primary" size="sm" disabled={!state.agents.length}>
                Send to {state.agents.find((agent) => agent.invited)?.name ?? 'agent'}
              </Button>
              {!ready ? (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => dispatch({ type: 'open-settings', tab: 'backends' })}
                >
                  Detect a CLI backend
                </button>
              ) : null}
            </form>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => dispatch({ type: 'open-settings', tab: 'agents' })}
            >
              <Icon name="plus" /> Manage agents
            </Button>
          </div>
        ) : state.rightTab === 'comments' && client ? (
          <div className="rail__body">
            <CommentsPanel
              comments={comments}
              youId={state.profile.userId}
              youHandle={state.profile.handle}
              participants={participants}
              selectedId={selectedThread}
              onSelect={setSelectedThread}
              onReveal={(id) => revealRef.current?.(id)}
              draft={commentDraft}
              onCloseDraft={() => setCommentDraft(null)}
              onNotice={(message) => dispatch({ type: 'notice', message })}
              readOnly={session.share.readOnly}
            />
          </div>
        ) : state.rightTab === 'history' && client ? (
          <div className="rail__body">
            <HistoryPanel
              client={client}
              history={history}
              youId={state.profile.userId}
              selectedId={selectedHistory}
              onSelect={setSelectedHistory}
              onView={setTravel}
              onRestore={(entry) => {
                setTravel(null)
                setRestoreTo(entry)
              }}
              readOnly={session.share.readOnly}
            />
          </div>
        ) : state.rightTab === 'markdown' ? (
          <div className="rail__body">
            <p className="rail__lede">Markdown for the current block. Read-only.</p>
            <pre className="markdown-source" aria-label="Markdown source">
              {blockMarkdown || 'Select a block to see its Markdown.'}
            </pre>
          </div>
        ) : (
          <div className="rail__body">
            {state.activity.length === 0 ? (
              <p className="empty">
                Edits, agent turns, and share events will show up here with attribution.
              </p>
            ) : (
              <ol className="activity">
                {state.activity.map((event) => (
                  <li key={event.id}>
                    <span className="activity__time">{formatClock(event.at)}</span>
                    <div>
                      <strong>{event.actor}</strong>
                      <p>{event.summary}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
