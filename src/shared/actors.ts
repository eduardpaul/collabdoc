/** Palette for humans and agents. Keep in sync with the Settings colour row. */

export const USER_COLORS = [
  '#c45c26',
  '#1f8a70',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#d97706',
  '#0ea5e9',
  '#65a30d'
] as const

export const AGENT_COLORS = USER_COLORS

export function agentColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length]
}

export function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return USER_COLORS[hash % USER_COLORS.length]
}
