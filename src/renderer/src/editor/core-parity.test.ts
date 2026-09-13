import { getSchema } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { createDocument } from '@core/document'
import { SyncHub } from '@core/hub'
import { DocumentSession } from '@core/session'
import { allBlocks, getRoot, nodeName, toBlockView } from '@core/tree'
import { WRITER_TOOLS } from '@shared/tools'
import type { MutationResult } from '@shared/types'
import { createNodeFromLoroObj, updateLoroToPmState, type LoroDocType } from 'loro-prosemirror'
import { describe, expect, it } from 'vitest'
import { schemaExtensions } from './schema'

/**
 * The core writes the Loro tree that `loro-prosemirror` reads with the real
 * editor schema, and the tree the editor writes is one the core's tools can
 * read back. If either direction breaks, agents and people stop seeing the
 * same document.
 */
describe('core ↔ loro-prosemirror parity', () => {
  const schema = getSchema(schemaExtensions())

  it('a document built through the tools becomes a valid ProseMirror doc', () => {
    const hub = SyncHub.create({ title: 'Parity' })
    const session = new DocumentSession(
      hub,
      { actorId: 'nova', name: 'Nova', color: '#000', role: 'agent' },
      { allowedTools: WRITER_TOOLS, enforceClaims: false }
    )
    const inserted = session.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [
        { type: 'heading', attrs: { level: 2 }, text: 'Title' },
        {
          type: 'paragraph',
          text: 'bold and linked',
          marks: [
            { type: 'bold', start: 0, end: 4 },
            { type: 'link', attrs: { href: 'https://example.com' }, start: 9, end: 15 }
          ]
        },
        { type: 'blockquote' },
        { type: 'bulletList' },
        { type: 'taskList' },
        { type: 'codeBlock', text: 'const x = 1' },
        { type: 'horizontalRule' },
        {
          type: 'mermaidFigure',
          text: 'flowchart LR\n  A --> B',
          attrs: { caption: 'Flow', width: 75 }
        },
        { type: 'infographicFigure', text: 'infographic list', attrs: { caption: 'Info' } },
        {
          type: 'imageFigure',
          attrs: { src: `asset:${'c'.repeat(64)}`, alt: 'pic', caption: 'Pic' }
        }
      ]
    }) as MutationResult
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    const [, , quote, bullets, tasks] = inserted.blocks.map((b) => b.blockId)
    for (const [parent, type] of [
      [quote, 'paragraph'],
      [bullets, 'listItem'],
      [tasks, 'taskItem']
    ] as const) {
      const child = session.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: parent },
        blocks: [{ type, attrs: type === 'taskItem' ? { checked: true } : {} }]
      }) as MutationResult
      expect(child.ok).toBe(true)
      if (!child.ok) return
      if (type !== 'paragraph') {
        const inner = session.call('insert_blocks', {
          at: { relation: 'inside_end', blockId: child.blocks[0].blockId },
          blocks: [{ type: 'paragraph', text: `inside ${type}` }]
        }) as MutationResult
        expect(inner.ok).toBe(true)
      }
    }

    const pmDoc = createNodeFromLoroObj(schema, getRoot(hub.doc) as never, new Map())
    expect(() => pmDoc.check()).not.toThrow()
    const json = pmDoc.toJSON()
    const types = (json.content as Array<{ type: string }>).map((n) => n.type)
    expect(types).toEqual([
      'paragraph',
      'heading',
      'paragraph',
      'blockquote',
      'bulletList',
      'taskList',
      'codeBlock',
      'horizontalRule',
      'mermaidFigure',
      'infographicFigure',
      'imageFigure'
    ])
    const paragraph = json.content[2]
    expect(paragraph.content[0]).toMatchObject({ text: 'bold', marks: [{ type: 'bold' }] })
    expect(paragraph.content[2]).toMatchObject({
      text: 'linked',
      marks: [{ type: 'link', attrs: { href: 'https://example.com' } }]
    })
    expect(json.content[8]).toMatchObject({
      attrs: { source: 'flowchart LR\n  A --> B', width: 75, align: 'center' },
      content: [{ type: 'text', text: 'Flow' }]
    })
    expect(json.content[10]).toMatchObject({
      attrs: { src: `asset:${'c'.repeat(64)}`, alt: 'pic' },
      content: [{ type: 'text', text: 'Pic' }]
    })
    expect(json.content[5].content[0]).toMatchObject({ type: 'taskItem', attrs: { checked: true } })
    expect(json.content[3].content[0]).toMatchObject({ type: 'paragraph' })
  })

  it('a document written by the editor is readable through the core', () => {
    const doc = createDocument()
    const pm = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'b_editor0001' },
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world', marks: [{ type: 'italic' }] }
          ]
        },
        {
          type: 'mermaidFigure',
          attrs: { blockId: 'b_editor0002', source: 'graph TD\n  X --> Y', align: 'left' },
          content: [{ type: 'text', text: 'Caption' }]
        },
        {
          type: 'blockquote',
          attrs: { blockId: 'b_editor0003' },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'b_editor0004' },
              content: [{ type: 'text', text: 'Quoted' }]
            }
          ]
        }
      ]
    })
    updateLoroToPmState(doc as LoroDocType, new Map(), EditorState.create({ schema, doc: pm }))
    doc.commit()

    const blocks = allBlocks(doc).map(({ node }) => toBlockView(node)!)
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'mermaidFigure',
      'blockquote',
      'paragraph'
    ])
    expect(blocks[0]).toMatchObject({
      blockId: 'b_editor0001',
      text: 'Hello world',
      marks: [{ type: 'italic', start: 6, end: 11 }]
    })
    expect(blocks[1]).toMatchObject({
      blockId: 'b_editor0002',
      text: 'graph TD\n  X --> Y',
      attrs: { caption: 'Caption', align: 'left' }
    })
    expect(blocks[3]).toMatchObject({ blockId: 'b_editor0004', text: 'Quoted' })
    expect(allBlocks(doc).map(({ node }) => nodeName(node))).toHaveLength(4)

    // And the same tree edited through a session is what the editor gets back.
    const hub = new SyncHub(doc)
    const session = new DocumentSession(hub, {
      actorId: 'ana',
      name: 'Ana',
      color: '#000',
      role: 'human'
    })
    const edit = session.call('replace_text', {
      blockId: 'b_editor0001',
      locator: { find: 'world' },
      text: 'there'
    }) as MutationResult
    expect(edit.ok).toBe(true)
    const back = createNodeFromLoroObj(schema, getRoot(hub.doc) as never, new Map())
    expect(() => back.check()).not.toThrow()
    expect(back.textContent).toBe('Hello thereCaptionQuoted')
  })
})
