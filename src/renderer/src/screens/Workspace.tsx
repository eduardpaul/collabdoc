import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@core/history'
import { DocumentEditor } from '../components/DocumentEditor'
import { HistoryPanel } from '../components/HistoryPanel'
import { Button, Icon, StatusDot, TextArea, TextInput } from '../components/ui'
import { hostLabel } from '../lib/host'
import { useAppState } from '../state/AppState'
import { aiReady } from '../state/selectors'
import { useSessionActions } from '../state/useSessionActions'
import { useDocumentClient } from '../sync/useDocumentClient'
import { useHistory } from '../sync/useHistory'
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
              {state.agents.map((agent) => (
                <li key={agent.id} className={`agent-card ${agent.invited ? 'is-invited' : ''}`}>
                  <header>
                    <span className={`role-badge role-badge--${agent.role}`}>{agent.role}</span>
                    <strong>{agent.name}</strong>
                    <StatusDot
                      tone={agent.status === 'working' ? 'work' : agent.invited ? 'live' : 'off'}
                    />
                  </header>
                  <p>{agent.persona}</p>
                  <div className="chips">
                    {agent.skills.map((skill) => (
                      <span key={skill} className="chip">
                        {skill}
                      </span>
                    ))}
                    <span className="chip chip--mute">
                      {agent.routing === 'mcp' ? 'MCP' : 'LLM'}
                    </span>
                  </div>
                  <div className="agent-card__actions">
                    <Button
                      size="sm"
                      variant={agent.invited ? 'secondary' : 'primary'}
                      onClick={() =>
                        dispatch({
                          type: 'update-agent',
                          id: agent.id,
                          patch: { invited: !agent.invited }
                        })
                      }
                    >
                      {agent.invited ? 'Remove from session' : 'Invite'}
                    </Button>
                    <Button
                      size="sm"
                      disabled={agent.status === 'working'}
                      onClick={() => runAsk(agent)}
                    >
                      {agent.status === 'working'
                        ? 'Working…'
                        : agent.role === 'writer'
                          ? 'Ask to draft'
                          : 'Ask to review'}
                    </Button>
                  </div>
                </li>
              ))}
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
                    : 'Configure a provider or MCP to enable this'
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
                  onClick={() => dispatch({ type: 'open-settings', tab: 'provider' })}
                >
                  Set up a provider or MCP
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
