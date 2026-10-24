import { readFileSync } from 'fs'
import { join } from 'path'
import { getSchema } from '@tiptap/core'
import { decodeCollabdoc } from '@core/collabdoc-file'
import { openDocument } from '@core/document'
import { allBlocks, getRoot, toBlockView } from '@core/tree'
import { BLOCK_ID_ATTR, BLOCK_ID_TYPES } from '@shared/constants'
import { createNodeFromLoroObj } from 'loro-prosemirror'
import { describe, expect, it } from 'vitest'
import { schemaExtensions } from './schema'

// Tests run from the repository root.
const FIXTURE = join(process.cwd(), 'crates/collabdoc-core/tests/fixtures/from-rust.collabdoc')

type Json = {
  type: string
  attrs?: Record<string, unknown>
  content?: Json[]
  text?: string
  marks?: Json[]
}

function walk(node: Json, visit: (node: Json) => void): void {
  visit(node)
  for (const child of node.content ?? []) walk(child, visit)
}

/**
 * The Rust editor (the Flutter/GPUI front ends) writes documents the Tiptap
 * editor loads unchanged: every block, list, quote and mark it makes. The
 * fixture is rewritten by `COLLABDOC_WRITE_FIXTURES=1 cargo test -p
 * collabdoc-core --test ts_compat` when the Rust editor changes.
 */
describe('Rust editor → Tiptap parity', () => {
  const doc = openDocument(decodeCollabdoc(new Uint8Array(readFileSync(FIXTURE))).snapshot)
  const schema = getSchema(schemaExtensions())
  const pm = createNodeFromLoroObj(schema, getRoot(doc) as never, new Map())
  const json = pm.toJSON() as Json

  it('is a valid document for the editor schema', () => {
    expect(() => pm.check()).not.toThrow()
    expect(json.content!.map((n) => n.type)).toEqual([
      'heading',
      'heading',
      'heading',
      'heading',
      'paragraph',
      'bulletList',
      'taskList',
      'blockquote',
      'codeBlock',
      'paragraph',
      'mermaidFigure',
      'paragraph',
      'horizontalRule',
      'paragraph',
      'taskList',
      'blockquote'
    ])
    expect(json.content!.slice(0, 4).map((n) => n.attrs?.level)).toEqual([1, 2, 3, 4])
  })

  it('keeps every mark, with the link target', () => {
    const marked = (json.content![4].content ?? []).filter((n) => n.marks?.length)
    expect(marked.map((n) => [n.text, n.marks!.map((m) => m.type)])).toEqual([
      ['bold', ['bold']],
      ['italic', ['italic']],
      ['underline', ['underline']],
      ['strike', ['strike']],
      ['code', ['code']],
      ['highlight', ['highlight']],
      ['sup', ['superscript']],
      ['sub', ['subscript']],
      ['a link', ['link']]
    ])
    expect(marked[8].marks![0].attrs).toMatchObject({ href: 'https://loro.dev' })
  })

  it('keeps lists, tasks, quotes, code and figures', () => {
    const [bullets, tasks, quote, code, , mermaid] = json.content!.slice(5)
    expect(bullets.content![0].content!.map((n) => n.type)).toEqual(['paragraph', 'orderedList'])
    expect(tasks.content!.map((n) => n.attrs?.checked)).toEqual([true, false])
    expect(quote.content!.map((n) => n.type)).toEqual(['paragraph', 'bulletList'])
    expect(code.attrs).toMatchObject({ language: 'rust' })
    expect(code.content![0].text).toBe('fn main() {}')
    expect(mermaid.attrs).toMatchObject({ source: 'flowchart LR\n  A --> B' })
    // Made with commands: a ticked task with a nested task, a quote.
    const made = json.content![14]
    expect(made.content![0].attrs?.checked).toBe(true)
    expect(made.content![0].content!.map((n) => n.type)).toEqual(['paragraph', 'taskList'])
    expect(json.content![15].content![0].content![0].text).toBe('quoted by Ctrl+Shift+B')
  })

  it('gives every block the editor tracks a unique blockId', () => {
    const tracked = new Set<string>(BLOCK_ID_TYPES)
    const ids: string[] = []
    walk(json, (node) => {
      if (tracked.has(node.type)) ids.push(String(node.attrs?.[BLOCK_ID_ATTR] ?? ''))
    })
    expect(ids.every((id) => /^b_[0-9a-f]{10}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reads through the TS core the same way', () => {
    const views = allBlocks(doc)
      .map(({ node }) => toBlockView(node))
      .filter((b) => b && b.text)
    expect(views.map((b) => b!.text)).toContain('quoted by Ctrl+Shift+B')
  })
})
