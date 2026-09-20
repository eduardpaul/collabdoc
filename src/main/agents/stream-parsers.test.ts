// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createParser, type ParsedEvent } from './stream-parsers'

function feed(parser: ReturnType<typeof createParser>, lines: string[]): ParsedEvent[] {
  const out: ParsedEvent[] = []
  for (const line of lines) out.push(...parser.push(line))
  out.push(...parser.finish())
  return out
}

// Trimmed from real `claude -p --output-format stream-json` output (2.1.149).
const CLAUDE = [
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"uuid":"x","session_id":"s"}',
  '{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"s","tools":[],"mcp_servers":[],"model":"claude-opus-4-7","permissionMode":"default"}',
  '{"type":"assistant","message":{"model":"claude-opus-4-7","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"OK"}],"stop_reason":null}}',
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":2224,"num_turns":1,"result":"OK","stop_reason":"end_turn","session_id":"s"}'
]

// Trimmed from real `grok -p --output-format streaming-messages-json` output (1.0.30).
const GROK = [
  '{"type":"system","subtype":"init","session_id":"g","apiKeySource":"oauth","model":"grok-4.6","cwd":"/tmp/x","permissionMode":"bypassPermissions","tools":["list_dir","search_tool","use_tool"]}',
  '{"type":"assistant","message":{"id":"msg_0","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"thinking","thinking":"…","signature":"…"},{"type":"text","text":"I\'ll list the current directory and report the entry count."},{"type":"tool_use","id":"call-1","name":"list_dir","input":{"target_directory":"."}}],"stop_reason":"tool_use"}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"{\\"type\\":\\"ListDir\\"}","is_error":false}]},"parent_tool_use_id":null,"session_id":"g"}',
  '{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","model":"grok-4.6","content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"6"}],"stop_reason":"end_turn"}}',
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":3347,"num_turns":2,"result":"6","stop_reason":"end_turn","session_id":"g"}'
]

// Trimmed from real `agy -p --output-format stream-json` output (1.2.2).
const AGY = [
  '{"event":"init","conversation_id":"c","init":{"cwd":"/tmp/x","tools":["ask_question","call_mcp_tool","read_file"]}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","arguments":{"server":"collabdoc","tool":"get_document"}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":0.15}}',
  '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"OK\\n","duration_seconds":1.8,"num_turns":1}}'
]

describe('stream parsers', () => {
  it('reads Claude Code stream-json: init, text, result; ignores rate-limit envelopes', () => {
    const events = feed(createParser('messages'), CLAUDE)
    expect(events).toEqual([
      { type: 'init', model: 'claude-opus-4-7', tools: [] },
      { type: 'text', text: 'OK', delta: false },
      { type: 'result', text: 'OK', isError: false, detail: null }
    ])
  })

  it('reads grok streaming-messages-json with tool_use and tool_result blocks', () => {
    const events = feed(createParser('messages'), GROK)
    expect(events.map((e) => e.type)).toEqual([
      'init',
      'text',
      'tool_use',
      'tool_result',
      'text',
      'result'
    ])
    expect(events[2]).toEqual({
      type: 'tool_use',
      name: 'list_dir',
      input: { target_directory: '.' },
      id: 'call-1'
    })
    expect(events[3]).toMatchObject({ type: 'tool_result', id: 'call-1', isError: false })
    expect(events.at(-1)).toEqual({ type: 'result', text: '6', isError: false, detail: null })
  })

  it('maps a Claude error result (e.g. max turns) to an error result with the subtype', () => {
    const events = feed(createParser('messages'), [
      '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":24,"result":""}'
    ])
    expect(events).toEqual([{ type: 'result', text: '', isError: true, detail: 'error_max_turns' }])
  })

  it('synthesises a result when the stream ends without one', () => {
    const events = feed(createParser('messages'), [CLAUDE[1], CLAUDE[2]])
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      text: 'OK',
      isError: false,
      detail: 'stream ended without result'
    })
  })

  it('reads Antigravity stream-json: tool steps once per step_index, text deltas, result', () => {
    const events = feed(createParser('antigravity'), AGY)
    expect(events.map((e) => e.type)).toEqual(['init', 'tool_use', 'text', 'text', 'result'])
    expect(events[1]).toMatchObject({ type: 'tool_use', name: 'call_mcp_tool', id: '1' })
    expect(events[2]).toEqual({ type: 'text', text: 'OK', delta: true })
    expect(events.at(-1)).toEqual({ type: 'result', text: 'OK', isError: false, detail: null })
  })

  it('reads Codex exec --json items', () => {
    const events = feed(createParser('codex'), [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"mcp_tool_call","server":"collabdoc","tool":"get_document","arguments":{},"status":"completed","result":{"ok":true}}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Done."}}',
      '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ])
    expect(events.map((e) => e.type)).toEqual(['init', 'tool_use', 'tool_result', 'text', 'result'])
    expect(events[1]).toMatchObject({ type: 'tool_use', name: 'collabdoc__get_document' })
    expect(events.at(-1)).toEqual({ type: 'result', text: 'Done.', isError: false, detail: null })
  })

  it('plain output becomes the result text', () => {
    const events = feed(createParser('plain'), ['first line', 'second line'])
    expect(events.at(-1)).toEqual({
      type: 'result',
      text: 'first line\nsecond line',
      isError: false,
      detail: null
    })
  })

  it('ignores garbage lines', () => {
    expect(feed(createParser('messages'), ['not json', '{"type":"unknown"}', ''])).toEqual([
      { type: 'result', text: '', isError: false, detail: 'stream ended without result' }
    ])
  })
})
