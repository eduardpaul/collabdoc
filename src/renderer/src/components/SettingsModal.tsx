import { useAppState } from '../state/AppState'
import { saveProfile } from '../sync/identity'
import type { LlmKind } from '../types'
import { ProfileFields } from './ProfileFields'
import { AgentsTab } from './settings/AgentsTab'
import { BackendsTab } from './settings/BackendsTab'
import { ExportTab } from './settings/ExportTab'
import { SourcesTab } from './settings/SourcesTab'
import { Button, Field, Modal, Select, TextInput } from './ui'

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

const TABS = ['you', 'provider', 'backends', 'sources', 'agents', 'export'] as const

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  you: 'You',
  provider: 'LLM provider',
  backends: 'Backends',
  sources: 'Sources',
  agents: 'Agents',
  export: 'Export'
}

export function SettingsModal(): React.JSX.Element | null {
  const { state, dispatch } = useAppState()

  if (!state.settingsOpen) {
    return null
  }

  return (
    <Modal
      wide
      title="Session setup"
      subtitle="Optional. Agents stay idle until a CLI backend is available or a provider is set."
      onClose={() => dispatch({ type: 'close-settings' })}
    >
      <div className="tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={state.settingsTab === tab}
            className={`tabs__btn ${state.settingsTab === tab ? 'is-active' : ''}`}
            onClick={() => dispatch({ type: 'set-settings-tab', tab })}
          >
            {TAB_LABELS[tab]}
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

      {state.settingsTab === 'backends' ? <BackendsTab /> : null}
      {state.settingsTab === 'sources' ? <SourcesTab /> : null}
      {state.settingsTab === 'agents' ? <AgentsTab /> : null}
      {state.settingsTab === 'export' ? <ExportTab /> : null}
    </Modal>
  )
}
