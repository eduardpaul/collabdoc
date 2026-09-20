/**
 * The MCP server entries a CLI run needs, rendered in each CLI's own config
 * dialect. Every file lands in the run's scratch dir and is removed after the
 * run: it carries the document server's bearer token and any source secrets.
 */

export type McpServerEntry = {
  name: string
  transport: 'http' | 'stdio'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Only these tools of the server may be used; null/undefined = all (AC-18.2). */
  toolAllowlist?: string[] | null
}

/** Claude Code `--mcp-config` (also what most JSON-configured clients accept). */
export function claudeMcpJson(entries: McpServerEntry[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const entry of entries) {
    mcpServers[entry.name] =
      entry.transport === 'http'
        ? { type: 'http', url: entry.url, headers: entry.headers ?? {} }
        : { type: 'stdio', command: entry.command, args: entry.args ?? [], env: entry.env ?? {} }
  }
  return JSON.stringify({ mcpServers }, null, 2)
}

/**
 * Gemini CLI project `.gemini/settings.json`; `tools.core: []` removes its
 * built-ins and a server's `includeTools` limits it to an allowlist.
 */
export function geminiSettingsJson(entries: McpServerEntry[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const entry of entries) {
    mcpServers[entry.name] = {
      ...(entry.transport === 'http'
        ? { httpUrl: entry.url, headers: entry.headers ?? {} }
        : { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} }),
      ...(entry.toolAllowlist ? { includeTools: entry.toolAllowlist } : {})
    }
  }
  return JSON.stringify({ mcpServers, tools: { core: [] } }, null, 2)
}

/** grok project `.grok/config.toml`; only `[mcp_servers]` is read from project scope. */
export function grokConfigToml(entries: McpServerEntry[]): string {
  const out: string[] = []
  for (const entry of entries) {
    out.push(`[mcp_servers.${tomlKey(entry.name)}]`)
    if (entry.transport === 'http') {
      out.push(`url = ${tomlString(entry.url ?? '')}`)
    } else {
      out.push(`command = ${tomlString(entry.command ?? '')}`)
      out.push(`args = [${(entry.args ?? []).map(tomlString).join(', ')}]`)
    }
    out.push('enabled = true', '')
    const table = entry.transport === 'http' ? entry.headers : entry.env
    const key = entry.transport === 'http' ? 'headers' : 'env'
    if (table && Object.keys(table).length > 0) {
      out.push(`[mcp_servers.${tomlKey(entry.name)}.${key}]`)
      for (const [k, v] of Object.entries(table)) out.push(`${tomlKey(k)} = ${tomlString(v)}`)
      out.push('')
    }
  }
  return out.join('\n')
}

/** Codex `-c` overrides, one `key=value` per entry (TOML inline values). */
export function codexOverrides(entries: McpServerEntry[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    const base = `mcp_servers.${tomlKey(entry.name)}`
    if (entry.transport === 'http') {
      out.push(`${base}.url=${tomlString(entry.url ?? '')}`)
      if (entry.headers && Object.keys(entry.headers).length > 0) {
        out.push(`${base}.http_headers=${inlineTable(entry.headers)}`)
      }
    } else {
      out.push(`${base}.command=${tomlString(entry.command ?? '')}`)
      out.push(`${base}.args=[${(entry.args ?? []).map(tomlString).join(', ')}]`)
      if (entry.env && Object.keys(entry.env).length > 0)
        out.push(`${base}.env=${inlineTable(entry.env)}`)
    }
    if (entry.toolAllowlist)
      out.push(`${base}.enabled_tools=[${entry.toolAllowlist.map(tomlString).join(', ')}]`)
  }
  return out
}

function inlineTable(table: Record<string, string>): string {
  return `{ ${Object.entries(table)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
    .join(', ')} }`
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}
