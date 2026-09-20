import { useState } from 'react'
import { USER_COLORS } from '@shared/actors'
import { BACKEND_IDS, type BackendId } from '@shared/agents'
import { handleFromName, isValidHandle, normalizeHandle } from '@shared/handles'
import { createId } from '../../lib/ids'
import { useAppState } from '../../state/AppState'
import { newAgentDraft } from '../../state/defaults'
import type { Agent, AgentProvider, AgentRole } from '../../types'
import { Button, Field, Icon, Select, TextArea, TextInput } from '../ui'

function providerValue(provider: AgentProvider): string {
  return provider.kind === 'default' ? 'default' : provider.id
}

function providerFrom(value: string): AgentProvider {
  return value === 'default' ? { kind: 'default' } : { kind: 'backend', id: value as BackendId }
}

/** Settings → Agents: the persona roster (13, minimal) with its backend (17) and sources (18). */
export function AgentsTab(): React.JSX.Element {
  const { state, dispatch } = useAppState()
  const [draft, setDraft] = useState<Agent>(newAgentDraft())

  const backendOptions = BACKEND_IDS.map((id) => {
    const found = state.backends.find((b) => b.id === id)
    return { id, label: found?.label ?? id, available: found?.available ?? false }
  })

  const handleTaken = (handle: string, exceptId: string): boolean =>
    state.agents.some((a) => a.id !== exceptId && a.handle === handle)

  const addAgent = (): void => {
    const name = draft.name.trim()
    if (!name) {
      dispatch({ type: 'notice', message: 'Give the agent a name.' })
      return
    }
    const handle = draft.handle ? normalizeHandle(draft.handle) : handleFromName(name)
    if (!isValidHandle(handle)) {
      dispatch({ type: 'notice', message: 'Handles are 2–20 lower-case letters, digits, - or _.' })
      return
    }
    if (handleTaken(handle, draft.id)) {
      dispatch({ type: 'notice', message: `@${handle} is already taken by another agent.` })
      return
    }
    dispatch({
      type: 'add-agent',
      agent: {
        ...draft,
        id: createId('agent'),
        name,
        handle,
        persona: draft.persona.trim(),
        skills: draft.skills.filter(Boolean)
      }
    })
    setDraft(newAgentDraft())
  }

  const editor = (
    agent: Agent,
    patch: (patch: Partial<Agent>) => void,
    options: { compact?: boolean } = {}
  ): React.JSX.Element => (
    <>
      <div className="form-grid form-grid--compact">
        <Field label="Name">
          <TextInput value={agent.name} onChange={(event) => patch({ name: event.target.value })} />
        </Field>
        <Field label="Handle" hint="How people @mention it.">
          <TextInput
            value={agent.handle}
            placeholder={handleFromName(agent.name || 'agent')}
            onChange={(event) => patch({ handle: normalizeHandle(event.target.value) })}
          />
        </Field>
        <Field label="Role">
          <Select
            value={agent.role}
            onChange={(event) => patch({ role: event.target.value as AgentRole })}
          >
            <option value="writer">Writer</option>
            <option value="reviewer">Reviewer</option>
          </Select>
        </Field>
        <Field label="Runs on" hint="Auto picks the first available CLI backend.">
          <Select
            value={providerValue(agent.provider)}
            onChange={(event) => patch({ provider: providerFrom(event.target.value) })}
          >
            <option value="default">Auto (first available backend)</option>
            {backendOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.available ? '' : ' — not available'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Colour">
          <div className="chips">
            {USER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`chip ${agent.color === color ? 'is-active' : ''}`}
                style={{ background: color, color: '#fff', borderColor: color }}
                aria-label={`Colour ${color}`}
                aria-pressed={agent.color === color}
                onClick={() => patch({ color })}
              >
                {agent.color === color ? '✓' : ' '}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <Field label="Persona">
        <TextArea
          rows={options.compact ? 2 : 3}
          value={agent.persona}
          placeholder="How this agent should behave in the document"
          onChange={(event) => patch({ persona: event.target.value })}
        />
      </Field>
      <Field
        label="Skills"
        hint="Comma-separated hints the persona leans on; SKILL.md files come with 13."
      >
        <TextInput
          value={agent.skills.join(', ')}
          onChange={(event) =>
            patch({
              skills: event.target.value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            })
          }
        />
      </Field>
      {state.sources.length ? (
        <Field label="Knowledge sources" hint="External MCP servers this agent may consult.">
          <div className="chips">
            {state.sources.map((source) => {
              const on = agent.sources.includes(source.id)
              return (
                <label key={source.id} className={`chip ${on ? 'is-active' : 'chip--mute'}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!source.enabled}
                    onChange={() =>
                      patch({
                        sources: on
                          ? agent.sources.filter((s) => s !== source.id)
                          : [...agent.sources, source.id]
                      })
                    }
                  />{' '}
                  {source.label}
                  {source.enabled ? '' : ' (disabled)'}
                </label>
              )
            })}
          </div>
        </Field>
      ) : null}
    </>
  )

  return (
    <div className="stack">
      <p className="lede">
        Writers draft. Reviewers comment. Both show up in the session as participants and every
        change they make is attributed to them — never to the CLI that ran them.
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
                {editor(
                  agent,
                  (patch) => {
                    if (
                      patch.handle !== undefined &&
                      patch.handle &&
                      handleTaken(patch.handle, agent.id)
                    ) {
                      dispatch({ type: 'notice', message: `@${patch.handle} is already taken.` })
                      return
                    }
                    dispatch({ type: 'update-agent', id: agent.id, patch })
                  },
                  { compact: true }
                )}
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
        {editor(draft, (patch) => setDraft({ ...draft, ...patch }))}
        <div className="modal__actions">
          <Button variant="primary" onClick={addAgent}>
            <Icon name="plus" /> Add agent
          </Button>
        </div>
      </div>
    </div>
  )
}
