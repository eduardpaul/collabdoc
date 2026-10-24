/**
 * Cross-checks the Rust core against the TypeScript core (src/core).
 *
 *   bun ts-compat.ts write <out.collabdoc>   a document made by the TS core
 *   bun ts-compat.ts read <in.collabdoc>     the TS core's reading, as JSON
 *   bun ts-compat.ts presence <in.collabdoc> <presence.bin>
 *                                            where each presence entry's caret is
 *
 * Needs `loro-crdt` resolvable (repo `npm install`, or NODE_PATH).
 */
import { readFileSync, writeFileSync } from 'fs'
import { Cursor, EphemeralStore, LoroText } from 'loro-crdt'
import { decodeCollabdoc, encodeCollabdoc } from '../../../../src/core/collabdoc-file'
import { commitBoundary, createDocument, openDocument, readMeta } from '../../../../src/core/document'
import {
  allBlocks,
  blockMarks,
  createBlock,
  getChildren,
  getRoot,
  nodeName,
  blockIdFromCursor
} from '../../../../src/core/tree'
import type { EphemeralPayload } from '../../../../src/core/tools/presence'

const [mode, file] = process.argv.slice(2)

if (mode === 'write') {
  const doc = createDocument({ title: 'Made by the TypeScript core' })
  const root = getRoot(doc)
  getChildren(root).delete(0, 1)
  createBlock(root, 0, { type: 'heading', attrs: { level: 1 }, text: 'Compatibility' })
  createBlock(root, 1, {
    type: 'paragraph',
    text: 'Bold, italic, code and a link.',
    marks: [
      { type: 'bold', start: 0, end: 4 },
      { type: 'italic', start: 6, end: 12 },
      { type: 'code', start: 14, end: 18 },
      { type: 'link', start: 25, end: 29, attrs: { href: 'https://loro.dev' } }
    ]
  })
  const list = createBlock(root, 2, { type: 'bulletList' })
  const item = createBlock(list, 0, { type: 'listItem' })
  createBlock(item, 0, { type: 'paragraph', text: 'First item' })
  const nested = createBlock(item, 1, { type: 'orderedList' })
  const nestedItem = createBlock(nested, 0, { type: 'listItem' })
  createBlock(nestedItem, 0, { type: 'paragraph', text: 'Nested one' })
  const second = createBlock(list, 1, { type: 'listItem' })
  createBlock(second, 0, { type: 'paragraph', text: 'Second item' })
  createBlock(root, 3, { type: 'codeBlock', text: 'fn main() {\n    println!("hi");\n}' })
  createBlock(root, 4, { type: 'mermaidFigure', attrs: { source: 'graph TD; A-->B', caption: 'Flow' } })
  createBlock(root, 5, { type: 'paragraph', text: 'Unicode: café 👍🏽 你好' })
  commitBoundary(doc, { origin: 'actor:ts-fixture', message: 'fixture' })
  const meta = readMeta(doc)
  writeFileSync(
    file,
    encodeCollabdoc({ docId: meta.docId, title: meta.title, snapshot: doc.export({ mode: 'snapshot' }) })
  )
} else if (mode === 'read') {
  const decoded = decodeCollabdoc(new Uint8Array(readFileSync(file)))
  const doc = openDocument(decoded.snapshot)
  const containers = ['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'blockquote']
  const blocks = allBlocks(doc)
    .filter(({ node }) => !containers.includes(nodeName(node)))
    .map(({ node }) => {
      const first = getChildren(node).get(0)
      const text = first instanceof LoroText ? first.toString() : ''
      return { type: nodeName(node), text, marks: blockMarks(node) }
    })
  console.log(JSON.stringify({ title: readMeta(doc).title, blocks }))
} else if (mode === 'presence') {
  const doc = openDocument(decodeCollabdoc(new Uint8Array(readFileSync(file))).snapshot)
  const store = new EphemeralStore(15_000)
  store.apply(new Uint8Array(readFileSync(process.argv[4])))
  const states = store.getAllStates() as Record<string, EphemeralPayload>
  const carets = Object.entries(states).map(([peer, state]) => ({
    peer,
    user: state.user,
    focus: state.focus ? blockIdFromCursor(doc, Cursor.decode(state.focus)) : null,
    anchor: state.anchor ? blockIdFromCursor(doc, Cursor.decode(state.anchor)) : null
  }))
  console.log(JSON.stringify(carets))
} else {
  console.error('usage: ts-compat.ts write|read|presence <file> [presence.bin]')
  process.exit(2)
}
