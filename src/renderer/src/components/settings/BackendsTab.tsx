import { useEffect, useState } from 'react'
import {
  BACKEND_IDS,
  DEFAULT_CUSTOM_CLI,
  type BackendAvailability,
  type BackendId,
  type CustomCliConfig,
  type McpClientRole
} from '@shared/agents'
import { useAppState } from '../../state/AppState'
import { useSessionActions } from '../../state/useSessionActions'
import { Button, Field, Icon, Select, StatusDot, TextArea, TextInput } from '../ui'

function tone(backend: BackendAvailability | undefined): 'live' | 'warn' | 'off' | 'work' {
  if (!backend) return 'off'
  if (backend.available) return 'live'
  if (backend.path) return 'warn'
  return 'off'
}

function describe(backend: BackendAvailability | undefined): string {
  if (!backend) return 'Not checked yet'
  if (backend.available) {
    const auth =
      backend.auth === 'ok' ? 'signed in' : backend.auth === 'unknown' ? 'sign-in not checked' : ''
    return [backend.version ? `v${backend.version}` : null, auth, backend.path]
      .filter(Boolean)
      .join(' · ')
  }
  return backend.reason ?? 'Not available'
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Settings → Backends (17 + 16): which locally installed CLI agents can run
 * personas, and the document MCP server those CLIs (and the user's own
 * interactive sessions) connect to.
 */
export function BackendsTab(): React.JSX.Element {
  const { state, dispatch } = useAppState()
  const { refreshBackends } = useSessionActions()
  const [busy, setBusy] = useState<string | null>(null)
  const [custom, setCustom] = useState<CustomCliConfig>(DEFAULT_CUSTOM_CLI)
  const [setupFor, setSetupFor] = useState<BackendId>('claude-code')
  const [showToken, setShowToken] = useState(false)
  const server = state.mcpServer

  useEffect(() => {
    void window.api?.agents.getCustomCli().then((result) => {
      if (result.ok) setCustom(result.config)
    })
  }, [])

  const detectOne = async (id: BackendId): Promise<void> => {
    setBusy(id)
    const result = await window.api?.agents.detect(id)
    if (result?.ok) {
      dispatch({
        type: 'set-backends',
        backends: [...state.backends.filter((b) => b.id !== id), result.backend]
      })
    }
    setBusy(null)
  }

  const detectAll = async (): Promise<void> => {
    setBusy('all')
    await refreshBackends()
    setBusy(null)
  }

  const saveCustom = async (): Promise<void> => {
    setBusy('custom-cli')
    const result = await window.api?.agents.setCustomCli(custom)
    if (result?.ok) {
      setCustom(result.config)
      dispatch({
        type: 'set-backends',
        backends: [...state.backends.filter((b) => b.id !== 'custom-cli'), result.backend]
      })
      dispatch({ type: 'notice', message: 'Custom CLI saved' })
    } else if (result) {
      dispatch({ type: 'notice', message: result.error })
    }
    setBusy(null)
  }

  const applyServer = async (
    call: () => Promise<
      { ok: true; state: NonNullable<typeof server> } | { ok: false; error: string } | undefined
    >
  ): Promise<void> => {
    const result = await call()
    if (!result) return
    if (result.ok) dispatch({ type: 'set-mcp-server', state: result.state })
    else dispatch({ type: 'notice', message: result.error })
  }

  const copySetup = async (): Promise<void> => {
    const result = await window.api?.mcp.setupCommand(setupFor)
    if (!result?.ok) return
    dispatch({
      type: 'notice',
      message: (await copy(result.command)) ? 'Setup command copied' : result.command
    })
  }

  if (!window.api?.agents) {
    return (
      <div className="stack">
        <p className="lede">
          CLI backends run in the desktop app. In the browser there is nothing to detect.
        </p>
      </div>
    )
  }

  return (
    <div className="stack">
      <p className="lede">
        Personas run on a CLI agent you already have installed and signed in — Claude Code, grok,
        Antigravity, Gemini or Codex. CollabDoc launches it for one turn with the open document as
        its only tool surface; no API key is entered here.
      </p>
      <div className="modal__actions">
        <span className="muted">
          {state.backends.filter((b) => b.available).length} of {BACKEND_IDS.length} available
        </span>
        <Button size="sm" disabled={busy !== null} onClick={() => void detectAll()}>
          {busy === 'all' ? 'Detecting…' : 'Detect all'}
        </Button>
      </div>
      <ul className="settings-list">
        {BACKEND_IDS.filter((id) => id !== 'custom-cli').map((id) => {
          const backend = state.backends.find((b) => b.id === id)
          return (
            <li key={id} className="settings-row">
              <div className="settings-row__meta">
                <StatusDot tone={tone(backend)} />
                <div>
                  <strong>
                    {backend?.label ?? id}
                    {backend && !backend.verified ? (
                      <span
                        className="chip chip--mute"
                        title="Flags taken from the docs, not checked against an installed binary"
                      >
                        unverified
                      </span>
                    ) : null}
                  </strong>
                  <p className="muted">{describe(backend)}</p>
                  {backend && !backend.available && !backend.path ? (
                    <p className="muted">
                      Install: <code>{backend.installHint}</code>
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="settings-row__actions">
                <Button size="sm" disabled={busy !== null} onClick={() => void detectOne(id)}>
                  {busy === id ? 'Checking…' : backend?.available ? 'Re-check' : 'Detect'}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="card card--inset">
        <h3>Custom CLI</h3>
        <p className="muted">
          Any other headless agent CLI. Placeholders: <code>{'{prompt}'}</code>{' '}
          <code>{'{systemPrompt}'}</code> <code>{'{mcpUrl}'}</code> <code>{'{mcpToken}'}</code>{' '}
          <code>{'{mcpConfigFile}'}</code> <code>{'{cwd}'}</code> <code>{'{maxTurns}'}</code>.
        </p>
        <Field label="Command template">
          <TextArea
            rows={2}
            value={custom.command}
            placeholder='mycli -p "{prompt}" --mcp-config {mcpConfigFile} --output-format stream-json'
            onChange={(event) => setCustom({ ...custom, command: event.target.value })}
          />
        </Field>
        <div className="form-grid form-grid--compact">
          <Field label="Output format" hint="How CollabDoc reads what the CLI prints.">
            <Select
              value={custom.parser}
              onChange={(event) =>
                setCustom({ ...custom, parser: event.target.value as CustomCliConfig['parser'] })
              }
            >
              <option value="messages">Claude / grok stream-json</option>
              <option value="antigravity">Antigravity stream-json</option>
              <option value="codex">Codex exec --json</option>
              <option value="plain">Plain text</option>
            </Select>
          </Field>
          <Field label="MCP config file" hint="Written into the run's scratch dir before launch.">
            <Select
              value={custom.mcpConfigFormat}
              onChange={(event) =>
                setCustom({
                  ...custom,
                  mcpConfigFormat: event.target.value as CustomCliConfig['mcpConfigFormat']
                })
              }
            >
              <option value="claude-json">mcp.json (Claude Code shape)</option>
              <option value="gemini-settings">.gemini/settings.json</option>
              <option value="grok-toml">.grok/config.toml</option>
              <option value="none">
                None (use {'{mcpUrl}'} / {'{mcpToken}'})
              </option>
            </Select>
          </Field>
        </div>
        <div className="modal__actions">
          <span className="muted">
            {describe(state.backends.find((b) => b.id === 'custom-cli'))}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            onClick={() => void saveCustom()}
          >
            {busy === 'custom-cli' ? 'Saving…' : 'Save and detect'}
          </Button>
        </div>
      </div>

      <div className="card card--inset">
        <div className="modal__actions">
          <div>
            <h3>Document MCP server</h3>
            <p className="muted">
              {server?.running
                ? `Running on 127.0.0.1:${server.port}`
                : server?.error
                  ? `Could not start: ${server.error}`
                  : 'Off. Persona runs start it on demand.'}
            </p>
          </div>
          <Button
            size="sm"
            variant={server?.enabled ? 'secondary' : 'primary'}
            onClick={() => void applyServer(() => window.api!.mcp.setEnabled(!server?.enabled))}
          >
            {server?.enabled ? 'Keep off unless needed' : 'Keep running'}
          </Button>
        </div>
        <p className="muted">
          Your own interactive Claude Code, grok or Codex session can join the open document as an
          external participant: keep the server running, paste the setup command into that CLI, and
          approve it here the first time it calls in.
        </p>
        <div className="form-grid form-grid--compact">
          <Field label="Setup command for">
            <Select
              value={setupFor}
              onChange={(event) => setSetupFor(event.target.value as BackendId)}
            >
              <option value="claude-code">Claude Code</option>
              <option value="grok">Grok CLI</option>
              <option value="antigravity">Antigravity (agy)</option>
              <option value="gemini">Gemini CLI</option>
              <option value="codex">Codex</option>
              <option value="custom-cli">URL and header only</option>
            </Select>
          </Field>
          <Field label="Bearer token">
            <div className="settings-row__actions">
              <TextInput
                readOnly
                type={showToken ? 'text' : 'password'}
                value={server?.token ?? ''}
                aria-label="MCP bearer token"
              />
              <Button size="sm" variant="ghost" onClick={() => setShowToken((v) => !v)}>
                {showToken ? 'Hide' : 'Show'}
              </Button>
            </div>
          </Field>
        </div>
        <div className="modal__actions">
          <Button size="sm" disabled={!server?.running} onClick={() => void copySetup()}>
            <Icon name="link" /> Copy setup command
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (
                window.confirm(
                  'Rotate the token? Every connected client is disconnected and must be set up again.'
                )
              ) {
                void applyServer(() => window.api!.mcp.rotateToken())
              }
            }}
          >
            Rotate token
          </Button>
        </div>

        {server && server.pending.length > 0 ? (
          <ul className="settings-list">
            {server.pending.map((name) => (
              <li key={name} className="settings-row">
                <div className="settings-row__meta">
                  <StatusDot tone="work" />
                  <div>
                    <strong>{name} wants to join</strong>
                    <p className="muted">
                      Waiting for your choice; its calls are refused until then.
                    </p>
                  </div>
                </div>
                <div className="settings-row__actions">
                  {(['writer', 'reviewer', 'blocked'] as McpClientRole[]).map((role) => (
                    <Button
                      key={role}
                      size="sm"
                      variant={
                        role === 'writer' ? 'primary' : role === 'blocked' ? 'danger' : 'secondary'
                      }
                      onClick={() =>
                        void applyServer(() => window.api!.mcp.setClientRole({ name, role }))
                      }
                    >
                      {role === 'writer'
                        ? 'Allow'
                        : role === 'reviewer'
                          ? 'Reviewer only'
                          : 'Block'}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {server && Object.keys(server.clients).length > 0 ? (
          <>
            <h4 className="muted">Known clients</h4>
            <ul className="settings-list">
              {Object.entries(server.clients).map(([name, role]) => (
                <li key={name} className="settings-row">
                  <div className="settings-row__meta">
                    <Icon name="plug" />
                    <div>
                      <strong>{name}</strong>
                      <p className="muted">
                        {server.connected.filter((c) => c.name === name && !c.runId).length
                          ? 'connected now'
                          : 'not connected'}
                      </p>
                    </div>
                  </div>
                  <div className="settings-row__actions">
                    <Select
                      aria-label={`Role for ${name}`}
                      value={role}
                      onChange={(event) =>
                        void applyServer(() =>
                          window.api!.mcp.setClientRole({
                            name,
                            role: event.target.value as McpClientRole
                          })
                        )
                      }
                    >
                      <option value="writer">Writer</option>
                      <option value="reviewer">Reviewer</option>
                      <option value="blocked">Blocked</option>
                    </Select>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void applyServer(() => window.api!.mcp.forgetClient(name))}
                    >
                      Forget
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {server && server.connected.length > 0 ? (
          <>
            <h4 className="muted">Connected now</h4>
            <ul className="settings-list">
              {server.connected.map((client) => (
                <li key={client.sessionId} className="settings-row">
                  <div className="settings-row__meta">
                    <StatusDot tone={client.rateLimited ? 'warn' : 'live'} />
                    <div>
                      <strong>{client.name}</strong>
                      <p className="muted">
                        {client.runId ? 'persona run' : 'external'} · {client.role} · {client.calls}{' '}
                        call
                        {client.calls === 1 ? '' : 's'}
                        {client.rateLimited ? ' · rate limited' : ''}
                      </p>
                    </div>
                  </div>
                  <div className="settings-row__actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void applyServer(() => window.api!.mcp.disconnectClient(client.sessionId))
                      }
                    >
                      Disconnect
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  )
}
