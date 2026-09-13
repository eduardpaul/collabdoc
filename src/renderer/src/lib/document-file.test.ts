import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { BLOCK_ID_ATTR } from '../editor/constants'
import { docToMarkdown, markdownToDoc, parseDocument, serializeDocument } from './document-file'

function stripIds(node: JSONContent): JSONContent {
  const attrs = node.attrs ? { ...node.attrs } : undefined
  if (attrs && BLOCK_ID_ATTR in attrs) {
    delete attrs[BLOCK_ID_ATTR]
  }
  if (attrs && attrs.textAlign === 'left') {
    delete attrs.textAlign
  }
  const next: JSONContent = { type: node.type }
  if (attrs && Object.keys(attrs).length) {
    next.attrs = attrs
  }
  if (node.text) {
    next.text = node.text
  }
  if (node.marks) {
    next.marks = node.marks
  }
  if (node.content) {
    next.content = node.content.map(stripIds)
  }
  return next
}

function roundTrip(markdown: string): { first: JSONContent; second: JSONContent; out: string } {
  const first = markdownToDoc(markdown)
  const out = docToMarkdown(first)
  const second = markdownToDoc(out)
  return { first, second, out }
}

describe('markdown round-trip', () => {
  it('round-trips headings, lists, emphasis, links and code blocks', () => {
    const source = [
      'Hello **bold** and *italic* and `code`.',
      '',
      '## Section',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '[Tiptap](https://tiptap.dev)',
      '',
      '```',
      'const x = 1',
      '```'
    ].join('\n')

    const { first, second } = roundTrip(source)
    expect(stripIds(first)).toEqual(stripIds(second))
  })

  it('open → save → open keeps the supported structure', () => {
    const raw = [
      '# Spec notes',
      '',
      'A paragraph with **bold** and a [link](https://example.com).',
      '',
      '### Details',
      '',
      '- alpha',
      '- bravo',
      '',
      '```',
      'ok()',
      '```',
      ''
    ].join('\n')

    const opened = parseDocument(raw, 'Fallback')
    expect(opened.title).toBe('Spec notes')
    const saved = serializeDocument(opened.title, opened.content)
    const reopened = parseDocument(saved, 'Fallback')
    expect(reopened.title).toBe('Spec notes')
    expect(stripIds(reopened.content)).toEqual(stripIds(opened.content))
  })

  it('task lists survive markdown conversion', () => {
    const { first, second } = roundTrip('- [ ] todo\n- [x] done')
    expect(stripIds(first)).toEqual(stripIds(second))
    expect(JSON.stringify(first)).toContain('taskList')
  })
})
