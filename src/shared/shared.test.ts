import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from './base64'
import { isValidHandle, mentionedHandles, normalizeHandle } from './handles'
import { newBlockId, newDocId, newReplyId, newThreadId } from './ids'
import {
  DOCUMENT_WRITE_TOOLS,
  FIGURE_CONVENTIONS,
  REVIEWER_TOOLS,
  TEXT_TOOLS,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  WRITER_TOOLS,
  isToolName,
  toolsForRole
} from './tools'

describe('base64', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    expect(bytesToBase64(new Uint8Array())).toBe('')
  })
})

describe('handles', () => {
  it('normalises and validates', () => {
    expect(normalizeHandle('  @Ana María ')).toBe('ana-mara')
    expect(normalizeHandle('@@Rex_2')).toBe('rex_2')
    expect(normalizeHandle('x'.repeat(30))).toHaveLength(20)
    expect(isValidHandle('ana')).toBe(true)
    expect(isValidHandle('a')).toBe(false)
    expect(isValidHandle('Ana')).toBe(false)
    expect(isValidHandle('a'.repeat(21))).toBe(false)
  })

  it('finds mentions in text once each, ignoring emails and inner @', () => {
    expect(mentionedHandles('hi @rex and @Ana, @rex again; mail me@example.com; @x')).toEqual([
      'rex',
      'ana'
    ])
    expect(mentionedHandles('@rex')).toEqual(['rex'])
    expect(mentionedHandles('nothing')).toEqual([])
  })
})

describe('ids', () => {
  it('produce prefixed unique ids', () => {
    expect(newBlockId()).toMatch(/^b_[0-9a-f]{10}$/)
    expect(newThreadId()).toMatch(/^c_[0-9a-f]{10}$/)
    expect(newReplyId()).toMatch(/^r_[0-9a-f]{10}$/)
    expect(newDocId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(newBlockId()).not.toBe(newBlockId())
  })
})

describe('tool surface', () => {
  it('defines every tool exactly once with a JSON schema', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(TOOL_NAMES)
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
    }
    expect(
      TOOL_DEFINITIONS.filter((t) => t.description.includes(FIGURE_CONVENTIONS)).map((t) => t.name)
    ).toEqual(['get_blocks', 'insert_text', 'replace_text', 'insert_blocks', 'update_block'])
  })

  it('role sets: reviewers never get text tools; writers get everything', () => {
    for (const tool of TEXT_TOOLS) expect(REVIEWER_TOOLS).not.toContain(tool)
    expect(REVIEWER_TOOLS).not.toContain('set_presence')
    expect([...WRITER_TOOLS].sort()).toEqual([...TOOL_NAMES].sort())
    expect(toolsForRole('writer')).toBe(WRITER_TOOLS)
    expect(toolsForRole('reviewer')).toBe(REVIEWER_TOOLS)
    for (const tool of ['add_comment', 'reply_comment', 'resolve_comment', ...TEXT_TOOLS]) {
      expect(DOCUMENT_WRITE_TOOLS.has(tool as never)).toBe(true)
    }
    expect(DOCUMENT_WRITE_TOOLS.has('list_comments')).toBe(false)
    expect(isToolName('search')).toBe(true)
    expect(isToolName('rm -rf')).toBe(false)
  })
})
