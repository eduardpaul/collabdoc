import type { Agent, AppState } from '../types'

export function aiReady(state: AppState): boolean {
  const providerReady = state.provider.enabled && Boolean(state.provider.endpoint.trim())
  const mcpReady = state.mcp.some((item) => item.status === 'connected')
  return providerReady || mcpReady
}

export function agentCanRun(state: AppState, agent: Agent): boolean {
  if (agent.routing === 'mcp') {
    if (agent.mcpId) {
      return state.mcp.some((item) => item.id === agent.mcpId && item.status === 'connected')
    }
    return state.mcp.some((item) => item.status === 'connected')
  }
  return state.provider.enabled && Boolean(state.provider.endpoint.trim())
}
