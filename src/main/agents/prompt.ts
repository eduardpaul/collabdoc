import { ALLOWED_MARKS, ALLOWED_NODES, BLOCK_CONTAINER_TYPES } from '../../shared/constants'
import type { RunPersona } from '../../shared/agents'
import { REVIEWER_TOOLS, WRITER_TOOLS } from '../../shared/tools'

export type PromptContext = {
  persona: RunPersona
  docTitle: string
  docId: string
  /** MCP server name the CLI sees; tools are `<name>__<tool>` or `mcp__<name>__<tool>`. */
  serverName: string
  /** Attached external sources by MCP server name, with a one-line purpose each. */
  sources: Array<{ name: string; label: string }>
  maxTurns: number
}

/**
 * The system prompt for a CLI backend run (13's order: identity → role rules
 * → schema → persona → skills → document context). Generated from the shared
 * constants so it never drifts from what the document accepts.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const { persona } = ctx
  const tools = persona.role === 'writer' ? WRITER_TOOLS : REVIEWER_TOOLS
  const lines: string[] = []
  lines.push(
    `You are ${persona.name} (@${persona.handle}), a ${persona.role} working inside a CollabDoc document ` +
      `titled "${ctx.docTitle}" (docId ${ctx.docId}). You are one participant among people and other agents; ` +
      'every change you make is attributed to you and can be undone by you.'
  )
  lines.push('')
  lines.push(
    `The document is only reachable through the "${ctx.serverName}" MCP server. Its tools are: ${tools.join(', ')}. ` +
      'Do not read or write files on disk and do not run shell commands; nothing outside the MCP tools counts as work.'
  )
  lines.push('')
  if (persona.role === 'writer') {
    lines.push(
      'Role rules (writer): start with get_document, read the blocks you will touch with get_blocks, then edit ' +
        'with insert_text / replace_text / insert_blocks / update_block / delete_blocks. Prefer small, precise ' +
        'edits over rewriting whole blocks. Re-read a block before replacing text in it. Leave a short ' +
        '`reason` on edits. Finish with one or two sentences describing what you changed.'
    )
  } else {
    lines.push(
      'Role rules (reviewer): you cannot change the text. Read with get_document / get_blocks / search, then ' +
        'leave comments with add_comment quoting the exact phrase, answer questions with reply_comment, and ' +
        'resolve_comment when a thread is settled. Finish with a short summary of what you flagged.'
    )
  }
  lines.push('')
  lines.push(
    `Schema: block types ${ALLOWED_NODES.join(', ')}; marks ${ALLOWED_MARKS.join(', ')}. Blocks can only be ` +
      `nested inside ${BLOCK_CONTAINER_TYPES.join(', ')}. Headings use attrs.level (1–4).`
  )
  if (persona.instructions.trim()) {
    lines.push('', `Persona: ${persona.instructions.trim()}`)
  }
  if (persona.skills.length) {
    lines.push('', `Skills to lean on: ${persona.skills.join(', ')}.`)
  }
  if (ctx.sources.length) {
    lines.push(
      '',
      `Knowledge sources you may consult (read-only MCP servers): ${ctx.sources
        .map((s) => `"${s.name}" (${s.label})`)
        .join(', ')}. When you use one, cite the source URL in the text you insert as a link.`
    )
  }
  lines.push(
    '',
    `You have at most ${ctx.maxTurns} tool turns; be economical and stop when the request is met.`
  )
  return lines.join('\n')
}
