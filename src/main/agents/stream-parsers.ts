import type { StreamParserId } from './cli-profiles'

/**
 * What a CLI's stdout tells us about a run, normalised. Tool calls on the
 * document are recorded by the MCP server regardless; the stream only adds
 * the assistant's text, external-tool activity and the final result.
 */
export type ParsedEvent =
  | { type: 'init'; model: string | null; tools: string[] }
  | { type: 'text'; text: string; delta: boolean }
  | { type: 'tool_use'; name: string; input: unknown; id: string | null }
  | { type: 'tool_result'; id: string | null; isError: boolean; text: string }
  | { type: 'result'; text: string; isError: boolean; detail: string | null }
  | { type: 'error'; message: string }

export interface StreamParser {
  /** One complete stdout line. */
  push(line: string): ParsedEvent[]
  /** Called at EOF; a parser without a result event synthesises one here. */
  finish(): ParsedEvent[]
}

export function createParser(id: StreamParserId): StreamParser {
  switch (id) {
    case 'messages':
      return new MessagesParser()
    case 'antigravity':
      return new AntigravityParser()
    case 'codex':
      return new CodexParser()
    default:
      return new PlainParser()
  }
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A parser reaching EOF without a terminal event reports what it saw. */
function endedWithoutResult(text: string): ParsedEvent {
  return { type: 'result', text, isError: false, detail: 'stream ended without result' }
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : typeof item === 'string'
            ? item
            : JSON.stringify(item)
      )
      .join('')
  }
  return JSON.stringify(value)
}

/**
 * Claude Code `--output-format stream-json` and grok
 * `--output-format streaming-messages-json`: Anthropic Messages wire shape,
 * one envelope per line (`system/init`, `assistant`, `user`, `result`).
 */
export class MessagesParser implements StreamParser {
  private sawResult = false
  private lastText = ''

  push(line: string): ParsedEvent[] {
    const rec = parseLine(line)
    if (!rec) return []
    const type = rec.type
    if (type === 'system' && rec.subtype === 'init') {
      return [
        {
          type: 'init',
          model: typeof rec.model === 'string' ? rec.model : null,
          tools: Array.isArray(rec.tools)
            ? rec.tools.filter((t): t is string => typeof t === 'string')
            : []
        }
      ]
    }
    if (type === 'assistant' || type === 'user') {
      const message = rec.message as { content?: unknown } | undefined
      const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : []
      const out: ParsedEvent[] = []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          this.lastText = b.text
          out.push({ type: 'text', text: b.text, delta: false })
        } else if (b.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            name: typeof b.name === 'string' ? b.name : 'tool',
            input: b.input ?? {},
            id: typeof b.id === 'string' ? b.id : null
          })
        } else if (b.type === 'tool_result') {
          out.push({
            type: 'tool_result',
            id: typeof b.tool_use_id === 'string' ? b.tool_use_id : null,
            isError: b.is_error === true,
            text: str(b.content)
          })
        }
      }
      return out
    }
    if (type === 'result') {
      this.sawResult = true
      const subtype = typeof rec.subtype === 'string' ? rec.subtype : null
      const isError = rec.is_error === true || (subtype !== null && subtype !== 'success')
      const text = typeof rec.result === 'string' && rec.result ? rec.result : this.lastText
      return [{ type: 'result', text, isError, detail: subtype === 'success' ? null : subtype }]
    }
    return []
  }

  finish(): ParsedEvent[] {
    return this.sawResult ? [] : [endedWithoutResult(this.lastText)]
  }
}

/**
 * Antigravity CLI `--output-format stream-json`: `init`, `step_update` with a
 * closed `step_type` vocabulary, terminal `result`.
 */
export class AntigravityParser implements StreamParser {
  private sawResult = false
  private text = ''
  private readonly announced = new Set<number>()

  push(line: string): ParsedEvent[] {
    const rec = parseLine(line)
    if (!rec) return []
    if (rec.event === 'init') {
      const init = (rec.init ?? {}) as { tools?: unknown; model?: unknown }
      return [
        {
          type: 'init',
          model: typeof init.model === 'string' ? init.model : null,
          tools: Array.isArray(init.tools)
            ? init.tools.filter((t): t is string => typeof t === 'string')
            : []
        }
      ]
    }
    if (rec.event === 'step_update') {
      const step = (rec.step_update ?? {}) as Record<string, unknown>
      const stepType = typeof step.step_type === 'string' ? step.step_type : ''
      const out: ParsedEvent[] = []
      if (stepType === 'agent_response') {
        if (typeof step.text_delta === 'string' && step.text_delta) {
          this.text += step.text_delta
          out.push({ type: 'text', text: step.text_delta, delta: true })
        }
        return out
      }
      if (stepType === 'user_input' || !stepType) return out
      const index = typeof step.step_index === 'number' ? step.step_index : -1
      if (!this.announced.has(index)) {
        this.announced.add(index)
        // A named tool (`call_mcp_tool`) reads as itself; a command step as `run_command: <cmd>`.
        const named = firstString(step, ['tool_name', 'mcp_tool_name', 'name'])
        const command = firstString(step, ['command_line', 'command'])
        const name = named ?? (command ? `${stepType}: ${command}` : stepType)
        out.push({
          type: 'tool_use',
          name,
          input: step.arguments ?? step.arguments_json ?? step.input ?? {},
          id: index >= 0 ? String(index) : null
        })
      }
      if (step.state === 'DONE' && (step.error || step.error_message)) {
        out.push({
          type: 'tool_result',
          id: index >= 0 ? String(index) : null,
          isError: true,
          text: str(step.error_message ?? step.error)
        })
      }
      return out
    }
    if (rec.event === 'result') {
      this.sawResult = true
      const result = (rec.result ?? {}) as Record<string, unknown>
      const status = typeof result.status === 'string' ? result.status : 'UNKNOWN'
      const isError = status !== 'SUCCESS'
      const text =
        typeof result.response === 'string' && result.response ? result.response : this.text
      return [
        {
          type: 'result',
          text: text.trim(),
          isError,
          detail: isError ? str(result.error ?? result.error_message ?? status) : null
        }
      ]
    }
    return []
  }

  finish(): ParsedEvent[] {
    return this.sawResult ? [] : [endedWithoutResult(this.text.trim())]
  }
}

/** Codex `codex exec --json`: `thread.*`, `turn.*` and `item.*` events. */
export class CodexParser implements StreamParser {
  private sawResult = false
  private lastText = ''
  private readonly announced = new Set<string>()

  push(line: string): ParsedEvent[] {
    const rec = parseLine(line)
    if (!rec) return []
    const type = typeof rec.type === 'string' ? rec.type : ''
    if (type === 'thread.started') return [{ type: 'init', model: null, tools: [] }]
    if (type === 'item.completed' || type === 'item.started') {
      const item = (rec.item ?? {}) as Record<string, unknown>
      const itemType = typeof item.type === 'string' ? item.type : ''
      if (itemType === 'agent_message' && type === 'item.completed') {
        const text = str(item.text)
        if (!text) return []
        this.lastText = text
        return [{ type: 'text', text, delta: false }]
      }
      if (
        itemType === 'mcp_tool_call' ||
        itemType === 'command_execution' ||
        itemType === 'web_search'
      ) {
        const id = typeof item.id === 'string' ? item.id : null
        const name =
          itemType === 'mcp_tool_call'
            ? `${str(item.server)}__${str(item.tool)}`
            : itemType === 'command_execution'
              ? `command: ${str(item.command)}`
              : 'web_search'
        const announce = id === null || !this.announced.has(id)
        if (id !== null) this.announced.add(id)
        const toolUse: ParsedEvent[] = announce
          ? [{ type: 'tool_use', name, input: item.arguments ?? {}, id }]
          : []
        if (type === 'item.started') return toolUse
        const isError = item.status === 'failed' || Boolean(item.error)
        return [
          ...toolUse,
          {
            type: 'tool_result',
            id,
            isError,
            text: str(item.error ?? item.result ?? item.aggregated_output)
          }
        ]
      }
      return []
    }
    if (type === 'turn.completed') {
      this.sawResult = true
      return [{ type: 'result', text: this.lastText, isError: false, detail: null }]
    }
    if (type === 'turn.failed' || type === 'error') {
      this.sawResult = true
      const error = (rec.error ?? {}) as { message?: unknown }
      const message = str(error.message ?? rec.message ?? 'Codex run failed')
      return [
        { type: 'error', message },
        { type: 'result', text: this.lastText, isError: true, detail: message }
      ]
    }
    return []
  }

  finish(): ParsedEvent[] {
    return this.sawResult ? [] : [endedWithoutResult(this.lastText)]
  }
}

/** Anything else: stdout is the answer. */
export class PlainParser implements StreamParser {
  private lines: string[] = []

  push(line: string): ParsedEvent[] {
    this.lines.push(line)
    return [{ type: 'text', text: `${line}\n`, delta: true }]
  }

  finish(): ParsedEvent[] {
    return [{ type: 'result', text: this.lines.join('\n').trim(), isError: false, detail: null }]
  }
}

function firstString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}
