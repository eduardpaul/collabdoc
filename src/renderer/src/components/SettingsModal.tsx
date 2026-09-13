import { useState } from 'react'
import { createId } from '../lib/ids'
import { useAppState } from '../state/AppState'
import { newAgentDraft } from '../state/defaults'
import { useSessionActions } from '../state/useSessionActions'
import { saveProfile } from '../sync/identity'
import type { Agent, AgentRole, AgentRouting, LlmKind, McpConnection } from '../types'
import { ProfileFields } from './ProfileFields'
import { Button, Field, Icon, Modal, Select, StatusDot, TextArea, TextInput } from './ui'

const providerPresets: Record<LlmKind, { label: string; endpoint: string; model: string }> = {
  'openai-compatible': {
    label: 'OpenAI-compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4.1'
  },
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5'
  },
  custom: { label: 'Custom endpoint', endpoint: 'http://127.0.0.1:11434/v1', model: '' }
}

function mcpTone(status: McpConnection['status']): 'live' | 'work' | 'off' | 'warn' {
  if (status === 'connected') {
    return 'live'
  }
  if (status === 'connecting') {
    return 'work'
  }
  if (status === 'error') {
    return 'warn'
  }
  return 'off'
}

export function SettingsModal(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()
  const { connectMcp, disconnectMcp } = useSessionActions()
  const [customLabel, setCustomLabel] = useState('Custom MCP')
  const [customCommand, setCustomCommand] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [draft, setDraft] = useState<Agent>(newAgentDraft())

  if (!state.settingsOpen) {
    return null
  }

  const addCustomMcp = (): void => {
    if (!customCommand.trim() && !customUrl.trim()) {
      dispatch({ type: 'notice', message: 'Add a command or an SSE URL for the MCP server.' })
      return
    }
    dispatch({
      type: 'add-mcp',
      connection: {
        id: createId('mcp'),
        kind: 'custom',
        label: customLabel.trim() || 'Custom MCP',
        transport: customUrl.trim() ? 'sse' : 'stdio',
        command: customCommand.trim(),
        url: customUrl.trim(),
        status: 'disconnected'
      }
    })
    setCustomCommand('')
    setCustomUrl('')
    dispatch({ type: 'notice', message: 'MCP server added' })
  }

  const addAgent = (): void => {
    if (!draft.name.trim()) {
      dispatch({ type: 'notice', message: 'Give the agent a name.' })
      return
    }
    dispatch({
      type: 'add-agent',
      agent: {
        ...draft,
        id: createId('agent'),
        name: draft.name.trim(),
        persona: draft.persona.trim(),
        skills: draft.skills.filter(Boolean)
      }
    })
    setDraft(newAgentDraft())
  }

  return (
    <Modal
      wide
      title="Session setup"
      subtitle="Optional. Agents stay idle until a provider or local MCP is connected."
      onClose={() => dispatch({ type: 'close-settings' })}
    >
      <div className="tabs" role="tablist">
        {(['you', 'provider', 'mcp', 'agents'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={state.settingsTab === tab}
            className={`tabs__btn ${state.settingsTab === tab ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'set-settings-tab', tab })}
          >
            {tab === 'you'
              ? 'You'
              : tab === 'provider'
                ? 'LLM provider'
                : tab === 'mcp'
                  ? 'Local MCP'
                  : 'Agents'}
          </button>
        ))}
      </div>

      {state.settingsTab === 'you' ? (
        <div className="stack">
          <p className="lede">Your name, handle and colour are how others see you in a session.</p>
          <ProfileFields
            name={state.profile.name}
            handle={state.profile.handle}
            color={state.profile.color}
            onChange={(patch) => {
              const next = { ...state.profile, ...patch, setupComplete: true }
              dispatch({ type: 'set-profile', profile: next })
              void saveProfile(next)
            }}
          />
        </div>
      ) : null}

      {state.settingsTab === 'provider' ? (
        <div className="stack">
          <p className="lede">
            Use any OpenAI-compatible or Anthropic-style endpoint. The key stays on this machine and
            is only sent to the URL you set.
          </p>
          <div className="form-grid">
            <Field label="Provider">
              <Select
                value={state.provider.kind}
                onChange={(event) => {
                  const kind = event.target.value as LlmKind
                  const preset = providerPresets[kind]
                  dispatch({
                    type: 'update-provider',
                    patch: {
                      kind,
                      label: preset.label,
                      endpoint: preset.endpoint,
                      model: preset.model
                    }
                  })
                }}
              >
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">Custom</option>
              </Select>
            </Field>
            <Field label="Model">
              <TextInput
                value={state.provider.model}
                placeholder="gpt-4.1, claude-sonnet-4-5, llama3…"
                onChange={(event) =>
                  dispatch({ type: 'update-provider', patch: { model: event.target.value } })
                }
              />
            </Field>
            <Field label="Endpoint" hint="Required to enable the provider. Local servers are fine.">
              <TextInput
                value={state.provider.endpoint}
                placeholder="https://api.openai.com/v1"
                onChange={(event) =>
                  dispatch({ type: 'update-provider', patch: { endpoint: event.target.value } })
                }
              />
            </Field>
            <Field label="API key" hint="Optional for local endpoints that do not require auth.">
              <TextInput
                type="password"
                autoComplete="off"
                value={state.provider.apiKey}
                placeholder="sk-…"
                onChange={(event) =>
                  dispatch({ type: 'update-provider', patch: { apiKey: event.target.value } })
                }
              />
            </Field>
          </div>
          <div className="modal__actions">
            <span className="muted">
              {state.provider.enabled
                ? `Ready · ${state.provider.label}${state.provider.model ? ' · ' + state.provider.model : ''}`
                : 'Not configured — you can still write locally'}
            </span>
            <Button
              onClick={() =>
                dispatch({
                  type: 'update-provider',
                  patch: { endpoint: '', apiKey: '', model: '', enabled: false }
                })
              }
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {state.settingsTab === 'mcp' ? (
        <div className="stack">
          <p className="lede">
            Point CollabDoc at Claude or Codex running locally. Agents then operate on the open
            document through MCP instead of a cloud key.
          </p>
          <ul className="settings-list">
            {state.mcp.map((server) => (
              <li key={server.id} className="settings-row">
                <div className="settings-row__meta">
                  <StatusDot tone={mcpTone(server.status)} />
                  <div>
                    <strong>{server.label}</strong>
                    <p className="muted">
                      {server.transport === 'sse' ? server.url || 'SSE' : server.command || 'stdio'}{' '}
                      · {server.status}
                    </p>
                  </div>
                </div>
                <div className="settings-row__actions">
                  {server.status === 'connected' ? (
                    <Button size="sm" onClick={() => disconnectMcp(server.id)}>
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={server.status === 'connecting'}
                      onClick={() => connectMcp(server.id)}
                    >
                      {server.status === 'connecting' ? 'Connecting…' : 'Connect'}
                    </Button>
                  )}
                  {server.kind === 'custom' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => dispatch({ type: 'remove-mcp', id: server.id })}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          <div className="form-grid">
            <Field label="Custom server name">
              <TextInput
                value={customLabel}
                onChange={(event) => setCustomLabel(event.target.value)}
              />
            </Field>
            <Field label="stdio command" hint="Used when no URL is set.">
              <TextInput
                value={customCommand}
                placeholder="npx -y my-mcp-server"
                onChange={(event) => setCustomCommand(event.target.value)}
              />
            </Field>
            <Field label="SSE URL" hint="Optional. Wins over the command if both are set.">
              <TextInput
                value={customUrl}
                placeholder="http://127.0.0.1:3847/sse"
                onChange={(event) => setCustomUrl(event.target.value)}
              />
            </Field>
          </div>
          <div className="modal__actions">
            <Button onClick={addCustomMcp}>
              <Icon name="plus" /> Add MCP server
            </Button>
          </div>
        </div>
      ) : null}

      {state.settingsTab === 'agents' ? (
        <div className="stack">
          <p className="lede">
            Writers draft. Reviewers comment. Both show up in the session as participants and every
            change they make will be attributed.
          </p>
          <Field
            label="Auto-send agent requests after idle"
            hint="An @agent paragraph left untouched this long is sent once. 0 keeps requests explicit (Enter). Never applies to people."
          >
            <Select
              aria-label="Auto-send agent requests"
              value={String(state.mentionAutoSendSeconds)}
              onChange={(event) =>
                dispatch({ type: 'set-mention-autosend', seconds: Number(event.target.value) })
              }
            >
              <option value="0">Off</option>
              <option value="5">5 s</option>
              <option value="8">8 s</option>
              <option value="15">15 s</option>
            </Select>
          </Field>
          <ul className="settings-list">
            {state.agents.map((agent) => (
              <li key={agent.id} className="settings-row settings-row--stack">
                <div className="settings-row__meta">
                  <Icon name={agent.role === 'writer' ? 'pen' : 'bot'} />
                  <div className="grow">
                    <div className="form-grid form-grid--compact">
                      <Field label="Name">
                        <TextInput
                          value={agent.name}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-agent',
                              id: agent.id,
                              patch: { name: event.target.value }
                            })
                          }
                        />
                      </Field>
                      <Field label="Role">
                        <Select
                          value={agent.role}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-agent',
                              id: agent.id,
                              patch: { role: event.target.value as AgentRole }
                            })
                          }
                        >
                          <option value="writer">Writer</option>
                          <option value="reviewer">Reviewer</option>
                        </Select>
                      </Field>
                      <Field label="Route through">
                        <Select
                          value={agent.routing}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-agent',
                              id: agent.id,
                              patch: { routing: event.target.value as AgentRouting }
                            })
                          }
                        >
                          <option value="llm">LLM provider</option>
                          <option value="mcp">Local MCP</option>
                        </Select>
                      </Field>
                    </div>
                    <Field label="Persona">
                      <TextArea
                        rows={2}
                        value={agent.persona}
                        onChange={(event) =>
                          dispatch({
                            type: 'update-agent',
                            id: agent.id,
                            patch: { persona: event.target.value }
                          })
                        }
                      />
                    </Field>
                    <Field label="Skills" hint="Comma-separated. Maps to DeepAgents skills later.">
                      <TextInput
                        value={agent.skills.join(', ')}
                        onChange={(event) =>
                          dispatch({
                            type: 'update-agent',
                            id: agent.id,
                            patch: {
                              skills: event.target.value
                                .split(',')
                                .map((item) => item.trim())
                                .filter(Boolean)
                            }
                          })
                        }
                      />
                    </Field>
                  </div>
                </div>
                <div className="settings-row__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => dispatch({ type: 'remove-agent', id: agent.id })}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="card card--inset">
            <h3>Add agent</h3>
            <div className="form-grid form-grid--compact">
              <Field label="Name">
                <TextInput
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="Role">
                <Select
                  value={draft.role}
                  onChange={(event) =>
                    setDraft({ ...draft, role: event.target.value as AgentRole })
                  }
                >
                  <option value="writer">Writer</option>
                  <option value="reviewer">Reviewer</option>
                </Select>
              </Field>
              <Field label="Route through">
                <Select
                  value={draft.routing}
                  onChange={(event) =>
                    setDraft({ ...draft, routing: event.target.value as AgentRouting })
                  }
                >
                  <option value="llm">LLM provider</option>
                  <option value="mcp">Local MCP</option>
                </Select>
              </Field>
            </div>
            <Field label="Persona">
              <TextArea
                rows={2}
                value={draft.persona}
                placeholder="How this agent should behave in the document"
                onChange={(event) => setDraft({ ...draft, persona: event.target.value })}
              />
            </Field>
            <div className="modal__actions">
              <Button variant="primary" onClick={addAgent}>
                <Icon name="plus" /> Add agent
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
