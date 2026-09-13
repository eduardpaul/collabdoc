import { hostLabel, modLabel } from '../lib/host'
import { useAppState } from '../state/AppState'
import { aiReady } from '../state/selectors'
import { useSessionActions } from '../state/useSessionActions'
import { Button, Icon, StatusDot } from '../components/ui'

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(delta / 60000)
  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function StartScreen(): React.JSX.Element {
  const { state, dispatch } = useAppState()
  const actions = useSessionActions()
  const ready = aiReady(state)
  const connectedMcp = state.mcp.filter((item) => item.status === 'connected')
  const mod = modLabel()

  return (
    <div className="start" data-screen="start">
      <header className="start__top">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            C
          </span>
          <div>
            <strong>CollabDoc</strong>
            <p>{hostLabel()} · local-first</p>
          </div>
        </div>
        <Button variant="ghost" onClick={() => dispatch({ type: 'open-settings' })}>
          <Icon name="settings" /> Settings
        </Button>
      </header>

      <div className="start__hero">
        <p className="eyebrow">Documents · agents · no server</p>
        <h1>Write together. Keep every keystroke on this machine.</h1>
        <p className="lede">
          Open a document, optionally connect an LLM or a local Claude/Codex MCP, then invite Writer
          and Reviewer agents into the session.
        </p>
      </div>

      <div className="start__actions">
        <Button variant="primary" onClick={actions.newDocument} data-testid="new-document">
          <Icon name="plus" /> New document
          <kbd>{mod}+N</kbd>
        </Button>
        <Button onClick={() => void actions.openDocument()} data-testid="open-document">
          <Icon name="folder" /> Open…
          <kbd>{mod}+O</kbd>
        </Button>
        <Button onClick={() => dispatch({ type: 'set-join-open', open: true })}>
          <Icon name="link" /> Join session
        </Button>
      </div>

      {state.recoveries.length > 0 ? (
        <section className="panel" data-testid="recover-drafts">
          <header className="panel__head">
            <h2>Recover</h2>
          </header>
          <ul className="recent-list">
            {state.recoveries.map((doc) => (
              <li key={doc.id}>
                <div className="recent-row recent-row--recover">
                  <Icon name="file" />
                  <span className="recent-row__body">
                    <strong>Recover &lsquo;{doc.title}&rsquo;</strong>
                    <span className="muted">Unsaved draft · {relativeTime(doc.updatedAt)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void actions.recoverDocument(doc.id)}
                  >
                    Recover
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <header className="panel__head">
          <h2>Recent</h2>
        </header>
        {state.recents.length === 0 ? (
          <p className="empty">No documents yet. Create one or open a file from disk.</p>
        ) : (
          <ul className="recent-list">
            {state.recents.map((doc) => (
              <li key={doc.id}>
                <button
                  type="button"
                  className={`recent-row ${doc.missing ? 'is-missing' : ''}`}
                  onClick={() => void actions.openRecent(doc.id)}
                >
                  <Icon name="file" />
                  <span className="recent-row__body">
                    <strong>
                      {doc.path || doc.missing ? doc.title : `Recover ‘${doc.title}’`}
                    </strong>
                    <span className="muted">
                      {doc.missing ? 'Moved or deleted' : (doc.path ?? 'Unsaved draft')} ·{' '}
                      {relativeTime(doc.updatedAt)}
                    </span>
                  </span>
                  {doc.preview ? <span className="recent-row__preview">{doc.preview}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel panel--ai" data-testid="ai-setup">
        <header className="panel__head">
          <h2>AI setup — optional</h2>
          <span className={`pill ${ready ? 'pill--live' : ''}`}>
            {ready ? 'Agents can run' : 'Skipped is fine'}
          </span>
        </header>
        <div className="ai-grid">
          <div className="ai-card">
            <div className="ai-card__title">
              <StatusDot tone={state.provider.enabled ? 'live' : 'off'} />
              <h3>LLM provider</h3>
            </div>
            <p>
              {state.provider.enabled
                ? `${state.provider.label}${state.provider.model ? ' · ' + state.provider.model : ''}`
                : 'Endpoint and key. Not required to start writing.'}
            </p>
            <Button size="sm" onClick={() => dispatch({ type: 'open-settings', tab: 'provider' })}>
              {state.provider.enabled ? 'Edit provider' : 'Configure provider'}
            </Button>
          </div>
          <div className="ai-card">
            <div className="ai-card__title">
              <StatusDot tone={connectedMcp.length ? 'live' : 'off'} />
              <h3>Local MCP</h3>
            </div>
            <p>
              {connectedMcp.length
                ? connectedMcp.map((item) => item.label).join(', ')
                : 'Claude or Codex running on this machine, with document tools.'}
            </p>
            <Button size="sm" onClick={() => dispatch({ type: 'open-settings', tab: 'mcp' })}>
              {connectedMcp.length ? 'Manage MCP' : 'Connect Claude / Codex'}
            </Button>
          </div>
        </div>
        <p className="muted start__note">
          You can skip this and write locally. Agents need a provider or MCP before they can edit or
          review the open document.
        </p>
      </section>
    </div>
  )
}
