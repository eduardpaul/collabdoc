import { BACKEND_IDS, type BackendAvailability, type BackendId } from '@shared/agents'
import type { Agent, AppState } from '../types'

/** Agents can run when any CLI backend is available (17) or a provider is configured (11). */
export function aiReady(state: AppState): boolean {
  const providerReady = state.provider.enabled && Boolean(state.provider.endpoint.trim())
  return providerReady || state.backends.some((item) => item.available)
}

/** Available backends in the order `default` picks them. */
export function availableBackends(state: AppState): BackendAvailability[] {
  return BACKEND_IDS.map((id) => state.backends.find((b) => b.id === id)).filter(
    (b): b is BackendAvailability => Boolean(b?.available)
  )
}

/**
 * The backend an agent's next run would use, or null when it cannot run.
 * `default` means the first available backend; a pinned backend must itself
 * be available. The LLM provider path is not runnable until 12 lands.
 */
export function resolveBackend(state: AppState, agent: Agent): BackendAvailability | null {
  if (agent.provider.kind === 'backend') {
    const id = agent.provider.id
    const pinned = state.backends.find((b) => b.id === id)
    return pinned?.available ? pinned : null
  }
  return availableBackends(state)[0] ?? null
}

export function agentCanRun(state: AppState, agent: Agent): boolean {
  return resolveBackend(state, agent) !== null
}

/** What the agent card's chip says about where the agent runs. */
export function backendLabel(state: AppState, agent: Agent): string {
  if (agent.provider.kind === 'backend') return labelOf(agent.provider.id, state)
  const first = availableBackends(state)[0]
  return first ? `Auto · ${first.label}` : 'Auto'
}

export function labelOf(id: BackendId, state: AppState): string {
  return state.backends.find((b) => b.id === id)?.label ?? id
}
