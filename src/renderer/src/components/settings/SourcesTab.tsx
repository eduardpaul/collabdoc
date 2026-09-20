import { useEffect, useState } from 'react'
import {
  MICROSOFT_LEARN_URL,
  type McpSource,
  type McpSourceInput,
  type McpSourcePreset
} from '@shared/agents'
import { useAppState } from '../../state/AppState'
import { Button, Field, Icon, Select, StatusDot, TextInput } from '../ui'

type Draft = {
  preset: McpSourcePreset
  label: string
  transport: 'http' | 'stdio'
  url: string
  command: string
  args: string
  folder: string
  headerName: string
  headerValue: string
  envName: string
  envValue: string
}

const emptyDraft = (preset: McpSourcePreset): Draft => ({
  preset,
  label:
    preset === 'microsoft-learn'
      ? 'Microsoft Learn'
      : preset === 'local-folder'
        ? 'Local folder'
        : '',
  transport: preset === 'local-folder' ? 'stdio' : 'http',
  url: preset === 'microsoft-learn' ? MICROSOFT_LEARN_URL : '',
  command: '',
  args: '',
  folder: '',
  headerName: '',
  headerValue: '',
  envName: '',
  envValue: ''
})

function healthTone(source: McpSource): 'live' | 'warn' | 'off' {
  if (source.health.status === 'ok') return source.enabled ? 'live' : 'off'
  if (source.health.status === 'error') return 'warn'
  return 'off'
}

function healthText(source: McpSource): string {
  switch (source.health.status) {
    case 'ok':
      return `ok · ${source.health.tools.length} tool${source.health.tools.length === 1 ? '' : 's'}`
    case 'error':
      return `error: ${source.health.message}`
    default:
      return 'not checked yet'
  }
}

/**
 * Settings → Sources (18): external MCP servers personas may consult.
 * Attached sources ride along in a CLI run as extra MCP servers named
 * `src_<slug>`; the document stays reachable only through its own server.
 */
export function SourcesTab(): React.JSX.Element {
  const { state, dispatch } = useAppState()
  const [draft, setDraft] = useState<Draft>(emptyDraft('microsoft-learn'))
  const [busy, setBusy] = useState<string | null>(null)
  const [unencrypted, setUnencrypted] = useState(false)
  const [editingTools, setEditingTools] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    const result = await window.api?.sources.list()
    if (result?.ok) {
      dispatch({ type: 'set-sources', sources: result.sources })
      setUnencrypted(result.secretsUnencrypted)
    }
  }

  useEffect(() => {
    let alive = true
    void window.api?.sources.list().then((result) => {
      if (!alive || !result?.ok) return
      dispatch({ type: 'set-sources', sources: result.sources })
      setUnencrypted(result.secretsUnencrypted)
    })
    return () => {
      alive = false
    }
  }, [dispatch])

  const upsert = async (input: McpSourceInput): Promise<McpSource | null> => {
    const result = await window.api?.sources.upsert(input)
    if (!result) return null
    if (!result.ok) {
      dispatch({ type: 'notice', message: result.error })
      return null
    }
    await reload()
    return result.source
  }

  const add = async (): Promise<void> => {
    const input: McpSourceInput = {
      label: draft.label.trim() || 'Source',
      preset: draft.preset,
      transport: draft.transport,
      enabled: true
    }
    if (draft.preset === 'local-folder') {
      if (!draft.folder) {
        dispatch({ type: 'notice', message: 'Choose the folder agents may read.' })
        return
      }
      input.args = [draft.folder]
    } else if (draft.preset === 'custom') {
      if (draft.transport === 'http') {
        if (!draft.url.trim()) {
          dispatch({ type: 'notice', message: 'Enter the MCP server URL.' })
          return
        }
        input.url = draft.url.trim()
        if (draft.headerName.trim())
          input.headers = { [draft.headerName.trim()]: draft.headerValue }
      } else {
        if (!draft.command.trim()) {
          dispatch({ type: 'notice', message: 'Enter the command that starts the server.' })
          return
        }
        input.command = draft.command.trim()
        input.args = draft.args.split(/\s+/).filter(Boolean)
        if (draft.envName.trim()) input.env = { [draft.envName.trim()]: draft.envValue }
      }
    }
    setBusy('add')
    const source = await upsert(input)
    if (source) {
      setDraft(emptyDraft('custom'))
      await refresh(source.id)
    }
    setBusy(null)
  }

  const refresh = async (id: string): Promise<void> => {
    setBusy(id)
    const result = await window.api?.sources.refresh(id)
    if (result && !result.ok) dispatch({ type: 'notice', message: result.error })
    await reload()
    setBusy(null)
  }

  const remove = async (source: McpSource): Promise<void> => {
    const users = state.agents.filter((a) => a.sources.includes(source.id))
    const suffix = users.length ? ` ${users.map((a) => a.name).join(', ')} will lose it.` : ''
    if (!window.confirm(`Remove ${source.label}?${suffix}`)) return
    await window.api?.sources.remove(source.id)
    for (const agent of users) {
      dispatch({
        type: 'update-agent',
        id: agent.id,
        patch: { sources: agent.sources.filter((s) => s !== source.id) }
      })
    }
    await reload()
  }

  const pickFolder = async (): Promise<void> => {
    const result = await window.api?.sources.pickFolder()
    if (result?.ok && result.path) setDraft({ ...draft, folder: result.path })
  }

  const toggleTool = async (source: McpSource, tool: string): Promise<void> => {
    const all = source.health.status === 'ok' ? source.health.tools.map((t) => t.name) : []
    const current = source.toolAllowlist ?? all
    const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]
    await upsert({
      id: source.id,
      label: source.label,
      preset: source.preset,
      transport: source.transport,
      toolAllowlist: next.length === all.length && all.every((t) => next.includes(t)) ? null : next
    })
  }

  if (!window.api?.sources) {
    return (
      <div className="stack">
        <p className="lede">External sources are managed by the desktop app.</p>
      </div>
    )
  }

  return (
    <div className="stack">
      <p className="lede">
        Give personas extra knowledge: Microsoft Learn, a read-only local folder, or any MCP server.
        Sources are off until you enable them and attach them to an agent. They can never write to
        the document — only the document tools can.
      </p>
      {unencrypted ? (
        <p className="muted">
          ⚠ This system has no keyring: source headers and env values are stored unencrypted in
          userData/secrets.bin.
        </p>
      ) : null}
      <ul className="settings-list">
        {state.sources.map((source) => {
          const tools = source.health.status === 'ok' ? source.health.tools : []
          const allowed = source.toolAllowlist
          return (
            <li key={source.id} className="settings-row settings-row--stack">
              <div className="modal__actions">
                <div className="settings-row__meta">
                  <StatusDot tone={healthTone(source)} />
                  <div>
                    <strong>
                      {source.label} <span className="chip chip--mute">src_{source.slug}</span>
                    </strong>
                    <p className="muted">
                      {source.transport === 'http'
                        ? source.url
                        : `${source.command} ${source.args.join(' ')}`}
                    </p>
                    <p className="muted">
                      {healthText(source)}
                      {allowed ? ` · ${allowed.length} allowed` : ''}
                      {state.agents.filter((a) => a.sources.includes(source.id)).length
                        ? ` · used by ${state.agents
                            .filter((a) => a.sources.includes(source.id))
                            .map((a) => a.name)
                            .join(', ')}`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="settings-row__actions">
                  <Button
                    size="sm"
                    variant={source.enabled ? 'secondary' : 'primary'}
                    onClick={() =>
                      void upsert({
                        id: source.id,
                        label: source.label,
                        preset: source.preset,
                        transport: source.transport,
                        enabled: !source.enabled
                      })
                    }
                  >
                    {source.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void refresh(source.id)}
                  >
                    {busy === source.id ? 'Checking…' : 'Refresh tools'}
                  </Button>
                  {tools.length && source.preset !== 'local-folder' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingTools(editingTools === source.id ? null : source.id)}
                    >
                      Tools
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void remove(source)}>
                    Remove
                  </Button>
                </div>
              </div>
              {editingTools === source.id ? (
                <ul className="settings-list">
                  {tools.map((tool) => {
                    const on = allowed ? allowed.includes(tool.name) : true
                    return (
                      <li key={tool.name} className="settings-row">
                        <label className="settings-row__meta">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => void toggleTool(source, tool.name)}
                          />
                          <div>
                            <strong>{tool.name}</strong>
                            <p className="muted">{tool.description || 'No description'}</p>
                          </div>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
              {source.preset === 'local-folder' && tools.length ? (
                <p className="muted">Read tools only: {(allowed ?? []).join(', ')}.</p>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="card card--inset">
        <h3>Add a source</h3>
        <div className="form-grid form-grid--compact">
          <Field label="Preset">
            <Select
              value={draft.preset}
              onChange={(event) => setDraft(emptyDraft(event.target.value as McpSourcePreset))}
            >
              <option value="microsoft-learn">Microsoft Learn</option>
              <option value="local-folder">Local folder (read-only)</option>
              <option value="custom">Custom MCP server</option>
            </Select>
          </Field>
          <Field label="Name">
            <TextInput
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </Field>
          {draft.preset === 'custom' ? (
            <Field label="Transport">
              <Select
                value={draft.transport}
                onChange={(event) =>
                  setDraft({ ...draft, transport: event.target.value as 'http' | 'stdio' })
                }
              >
                <option value="http">HTTP (URL)</option>
                <option value="stdio">stdio (command)</option>
              </Select>
            </Field>
          ) : null}
        </div>
        {draft.preset === 'local-folder' ? (
          <Field label="Folder" hint="Agents can read and search files here, nothing else.">
            <div className="settings-row__actions">
              <TextInput readOnly value={draft.folder} placeholder="Choose a folder…" />
              <Button size="sm" onClick={() => void pickFolder()}>
                <Icon name="folder" /> Choose
              </Button>
            </div>
          </Field>
        ) : null}
        {draft.preset === 'custom' && draft.transport === 'http' ? (
          <div className="form-grid">
            <Field label="URL">
              <TextInput
                value={draft.url}
                placeholder="https://example.com/mcp"
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </Field>
            <Field label="Header (optional)" hint="Stored encrypted; never shown again.">
              <div className="settings-row__actions">
                <TextInput
                  placeholder="Authorization"
                  value={draft.headerName}
                  onChange={(event) => setDraft({ ...draft, headerName: event.target.value })}
                />
                <TextInput
                  type="password"
                  autoComplete="off"
                  placeholder="Bearer …"
                  value={draft.headerValue}
                  onChange={(event) => setDraft({ ...draft, headerValue: event.target.value })}
                />
              </div>
            </Field>
          </div>
        ) : null}
        {draft.preset === 'custom' && draft.transport === 'stdio' ? (
          <div className="form-grid">
            <Field label="Command">
              <TextInput
                value={draft.command}
                placeholder="npx"
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              />
            </Field>
            <Field label="Arguments">
              <TextInput
                value={draft.args}
                placeholder="-y my-mcp-server"
                onChange={(event) => setDraft({ ...draft, args: event.target.value })}
              />
            </Field>
            <Field label="Env (optional)" hint="Stored encrypted; never shown again.">
              <div className="settings-row__actions">
                <TextInput
                  placeholder="API_KEY"
                  value={draft.envName}
                  onChange={(event) => setDraft({ ...draft, envName: event.target.value })}
                />
                <TextInput
                  type="password"
                  autoComplete="off"
                  placeholder="value"
                  value={draft.envValue}
                  onChange={(event) => setDraft({ ...draft, envValue: event.target.value })}
                />
              </div>
            </Field>
          </div>
        ) : null}
        {draft.preset === 'microsoft-learn' ? (
          <p className="muted">
            {MICROSOFT_LEARN_URL} · HTTP, no sign-in. Personas are asked to cite learn.microsoft.com
            links.
          </p>
        ) : null}
        <div className="modal__actions">
          <Button variant="primary" disabled={busy !== null} onClick={() => void add()}>
            <Icon name="plus" /> {busy === 'add' ? 'Adding…' : 'Add source'}
          </Button>
        </div>
      </div>
    </div>
  )
}
