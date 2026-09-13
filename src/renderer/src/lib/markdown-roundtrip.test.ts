import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { BLOCK_ID_ATTR } from '../editor/constants'
import { DEFAULT_INFOGRAPHIC, DEFAULT_MERMAID } from '../editor/figures/defaults'
import { docToMarkdown, markdownToDoc } from '../editor/markdown'

function stripVolatile(node: JSONContent): JSONContent {
  const attrs = node.attrs ? { ...node.attrs } : undefined
  if (attrs) {
    delete attrs[BLOCK_ID_ATTR]
    if (attrs.textAlign === 'left') {
      delete attrs.textAlign
    }
    if (attrs.width == null) {
      delete attrs.width
    }
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
    next.content = node.content.map(stripVolatile)
  }
  return next
}

describe('markdown figures', () => {
  it('round-trips mermaid and infographic fences with captions', () => {
    const source = [
      '```mermaid caption="Release flow"',
      DEFAULT_MERMAID,
      '```',
      '',
      '```infographic caption="Steps"',
      DEFAULT_INFOGRAPHIC,
      '```'
    ].join('\n')
    const first = markdownToDoc(source)
    const out = docToMarkdown(first)
    const second = markdownToDoc(out)
    expect(out).toContain('```mermaid caption="Release flow"')
    expect(out).toContain('```infographic caption="Steps"')
    expect(stripVolatile(first)).toEqual(stripVolatile(second))
  })

  it('round-trips images as asset markdown', () => {
    const source =
      '![alt](assets/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png "A photo")'
    const first = markdownToDoc(source)
    const out = docToMarkdown(first)
    const second = markdownToDoc(out)
    expect(first.content?.[0]?.type).toBe('imageFigure')
    expect(stripVolatile(first)).toEqual(stripVolatile(second))
  })
})

describe('markdown property round-trip', () => {
  it('survives 500 generated documents', () => {
    for (let i = 0; i < 500; i += 1) {
      const doc = generateDoc(i)
      const md = docToMarkdown(doc)
      const parsed = markdownToDoc(md)
      expect(stripVolatile(parsed)).toEqual(stripVolatile(ensureDoc(parsed)))
      const again = markdownToDoc(docToMarkdown(parsed))
      expect(stripVolatile(again)).toEqual(stripVolatile(parsed))
    }
  })
})

function ensureDoc(doc: JSONContent): JSONContent {
  return doc.type === 'doc' ? doc : { type: 'doc', content: [doc] }
}

function generateDoc(seed: number): JSONContent {
  const blocks: JSONContent[] = []
  const count = 3 + (seed % 6)
  for (let i = 0; i < count; i += 1) {
    const kind = (seed + i) % 8
    if (kind === 0) {
      blocks.push({
        type: 'heading',
        attrs: { level: ((seed + i) % 3) + 2 },
        content: [text('Heading', seed, i)]
      })
    } else if (kind === 1) {
      blocks.push({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [text('Item', seed, i)] }]
          }
        ]
      })
    } else if (kind === 2) {
      blocks.push({
        type: 'codeBlock',
        content: [{ type: 'text', text: `const n = ${seed + i}` }]
      })
    } else if (kind === 3) {
      blocks.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [text('Quote', seed, i)] }]
      })
    } else if (kind === 4) {
      blocks.push({
        type: 'mermaidFigure',
        attrs: { source: DEFAULT_MERMAID, align: 'center' },
        content: i % 2 === 0 ? [{ type: 'text', text: 'Flow' }] : []
      })
    } else if (kind === 5) {
      blocks.push({
        type: 'infographicFigure',
        attrs: { source: DEFAULT_INFOGRAPHIC, align: 'left' },
        content: i % 2 === 0 ? [{ type: 'text', text: 'Steps' }] : []
      })
    } else if (kind === 6) {
      blocks.push({
        type: 'imageFigure',
        attrs: {
          src: 'asset:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          alt: 'pic',
          align: 'right'
        },
        content: [{ type: 'text', text: 'Photo' }]
      })
    } else {
      blocks.push({
        type: 'paragraph',
        content: [text('Hello', seed, i, true)]
      })
    }
  }
  return { type: 'doc', content: blocks }
}

function text(base: string, seed: number, i: number, marked = false): JSONContent {
  const node: JSONContent = { type: 'text', text: `${base} ${seed}-${i}` }
  if (marked && i % 2 === 0) {
    node.marks = [{ type: 'bold' }, { type: 'italic' }]
  }
  if (marked && i % 3 === 0) {
    node.marks = [...(node.marks ?? []), { type: 'code' }]
  }
  return node
}
