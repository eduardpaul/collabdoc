import { Cursor, isContainer, LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt'
import {
  ASSET_SRC_PREFIX,
  ATOM_NODE_TYPES,
  ATTRIBUTES_KEY,
  BLOCK_CONTAINER_TYPES,
  BLOCK_ID_ATTR,
  CHILDREN_KEY,
  NODE_NAME_KEY,
  ROOT_DOC_KEY,
  SYNTAX_FIGURE_TYPES
} from '../shared/constants'
import { newBlockId } from '../shared/ids'
import type { BlockId, BlockOutline, BlockView, MarkView, NodeInput } from '../shared/types'
import { encodeAnchor } from './anchors'

export type LocatedBlock = {
  node: LoroMap
  parent: LoroMap | null
  index: number
}

export function getRoot(doc: LoroDoc): LoroMap {
  return doc.getMap(ROOT_DOC_KEY)
}

export function getAttrs(node: LoroMap): LoroMap {
  return node.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap())
}

export function getChildren(node: LoroMap): LoroList {
  return node.getOrCreateContainer(CHILDREN_KEY, new LoroList())
}

export function nodeName(node: LoroMap): string {
  const name = node.get(NODE_NAME_KEY)
  return typeof name === 'string' ? name : 'paragraph'
}

export function blockIdOf(node: LoroMap): BlockId | undefined {
  const id = getAttrs(node).get(BLOCK_ID_ATTR)
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function attrsJson(node: LoroMap): Record<string, unknown> {
  const json = getAttrs(node).toJSON() as Record<string, unknown> | undefined
  return json ?? {}
}

export function isSyntaxFigure(node: LoroMap): boolean {
  return (SYNTAX_FIGURE_TYPES as readonly string[]).includes(nodeName(node))
}

export function isSyntaxFigureType(type: string): boolean {
  return (SYNTAX_FIGURE_TYPES as readonly string[]).includes(type)
}

export function isAtomType(type: string): boolean {
  return (ATOM_NODE_TYPES as readonly string[]).includes(type)
}

/** Whether a block's children list holds blocks rather than text. */
export function isBlockContainerType(type: string): boolean {
  return (BLOCK_CONTAINER_TYPES as readonly string[]).includes(type)
}

export function isBlockContainer(node: LoroMap): boolean {
  return isBlockContainerType(nodeName(node))
}

export function hasBlockChildren(node: LoroMap): boolean {
  const children = getChildren(node)
  for (let i = 0; i < children.length; i += 1) {
    if (children.get(i) instanceof LoroMap) return true
  }
  return false
}

export function findBlock(doc: LoroDoc, blockId: BlockId): LocatedBlock | null {
  const walk = (node: LoroMap, parent: LoroMap | null, index: number): LocatedBlock | null => {
    if (blockIdOf(node) === blockId) return { node, parent, index }
    const children = getChildren(node)
    for (let i = 0; i < children.length; i += 1) {
      const child = children.get(i)
      if (child instanceof LoroMap) {
        const found = walk(child, node, i)
        if (found) return found
      }
    }
    return null
  }
  return walk(getRoot(doc), null, 0)
}

/** Every block with an id, in document order. */
export function allBlocks(doc: LoroDoc): LocatedBlock[] {
  const out: LocatedBlock[] = []
  const walk = (node: LoroMap, parent: LoroMap | null, index: number): void => {
    if (blockIdOf(node)) out.push({ node, parent, index })
    const children = getChildren(node)
    for (let i = 0; i < children.length; i += 1) {
      const child = children.get(i)
      if (child instanceof LoroMap) walk(child, node, i)
    }
  }
  walk(getRoot(doc), null, 0)
  return out
}

export function firstText(node: LoroMap): LoroText | null {
  const children = getChildren(node)
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroText) return child
  }
  return null
}

export function ensureText(node: LoroMap): LoroText {
  return firstText(node) ?? getChildren(node).insertContainer(0, new LoroText())
}

export function syntaxSourceOf(node: LoroMap): string {
  const source = getAttrs(node).get('source')
  return typeof source === 'string' ? source : ''
}

export function setSyntaxSource(node: LoroMap, source: string): void {
  getAttrs(node).set('source', source)
}

/**
 * The text agents read and edit: the diagram source for syntax figures,
 * nothing for an image (its caption is `attrs.caption`), otherwise the
 * visible text.
 */
export function blockAgentText(node: LoroMap): string {
  if (isSyntaxFigure(node)) return syntaxSourceOf(node)
  if (nodeName(node) === 'imageFigure') return ''
  return blockPlainText(node)
}

/** Visible text of a block and its descendants; for figures, the caption. */
export function blockPlainText(node: LoroMap): string {
  const children = getChildren(node)
  let out = ''
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroText) {
      out += child.toString()
      continue
    }
    if (!(child instanceof LoroMap)) continue
    if (nodeName(child) === 'mention') {
      const handle = getAttrs(child).get('handle') ?? getAttrs(child).get('label')
      if (typeof handle === 'string' && handle) out += `@${handle}`
      continue
    }
    const nested = blockPlainText(child)
    if (!nested) continue
    out += out && !out.endsWith('\n') ? `\n${nested}` : nested
  }
  return out
}

/** Figure captions live in the node's text so they are collaboratively editable. */
export function captionOf(node: LoroMap): string {
  return firstText(node)?.toString() ?? ''
}

export function setCaption(node: LoroMap, caption: string): void {
  const text = ensureText(node)
  if (text.length > 0) text.delete(0, text.length)
  if (caption) text.insert(0, caption)
}

export function blockMarks(node: LoroMap): MarkView[] {
  const text = firstText(node)
  if (!text) return []
  const marks: MarkView[] = []
  let offset = 0
  for (const run of text.toDelta()) {
    const insert = run.insert
    if (typeof insert !== 'string') continue
    const len = insert.length
    if (run.attributes) {
      for (const [type, attrs] of Object.entries(run.attributes)) {
        if (attrs == null) continue
        marks.push({
          type,
          attrs:
            typeof attrs === 'object' && !Array.isArray(attrs)
              ? (attrs as Record<string, unknown>)
              : {},
          start: offset,
          end: offset + len
        })
      }
    }
    offset += len
  }
  return marks
}

/**
 * FNV-1a over the block's agent-visible state. Not a security hash: a cheap
 * change detector so a stale `view` from a previous read is refused.
 */
export function viewOf(node: LoroMap): string {
  const payload = JSON.stringify({
    t: nodeName(node),
    a: attrsJson(node),
    c: isSyntaxFigure(node) ? captionOf(node) : undefined,
    x: blockAgentText(node),
    m: blockMarks(node)
  })
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < payload.length; i += 1) {
    const c = payload.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x811c9dc5)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

export function figureAttrs(node: LoroMap): Record<string, unknown> {
  const attrs = attrsJson(node)
  const type = nodeName(node)
  if (type === 'mermaidFigure' || type === 'infographicFigure' || type === 'imageFigure') {
    return { ...attrs, caption: captionOf(node) }
  }
  return attrs
}

export function toBlockView(node: LoroMap): BlockView | null {
  const blockId = blockIdOf(node)
  if (!blockId) return null
  const text = isSyntaxFigure(node) ? null : firstText(node)
  const content = blockAgentText(node)
  const start = text?.getCursor(0, -1) ?? null
  const end = text?.getCursor(content.length, 1) ?? null
  return {
    blockId,
    type: nodeName(node),
    attrs: figureAttrs(node),
    text: content,
    marks: isSyntaxFigure(node) ? [] : blockMarks(node),
    view: viewOf(node),
    anchors: {
      start: start ? encodeAnchor(start) : '',
      end: end ? encodeAnchor(end) : ''
    }
  }
}

export function outline(doc: LoroDoc, maxPreviewChars = 80): BlockOutline[] {
  const items: BlockOutline[] = []
  for (const { node } of allBlocks(doc)) {
    const blockId = blockIdOf(node)
    if (!blockId) continue
    items.push({
      blockId,
      type: nodeName(node),
      attrs: figureAttrs(node),
      preview: blockAgentText(node).slice(0, maxPreviewChars)
    })
  }
  return items
}

/** Content-addressed asset hashes referenced by image figures, deduplicated. */
export function listAssets(doc: LoroDoc): string[] {
  const out = new Set<string>()
  for (const { node } of allBlocks(doc)) {
    if (nodeName(node) !== 'imageFigure') continue
    const src = getAttrs(node).get('src')
    if (typeof src === 'string' && src.startsWith(ASSET_SRC_PREFIX)) {
      out.add(src.slice(ASSET_SRC_PREFIX.length))
    }
  }
  return [...out]
}

export function createBlock(parent: LoroMap, index: number, input: NodeInput): LoroMap {
  const children = getChildren(parent)
  const node = children.insertContainer(index, new LoroMap())
  node.set(NODE_NAME_KEY, input.type)
  const attrs = getAttrs(node)
  const requestedId = input.attrs?.[BLOCK_ID_ATTR]
  attrs.set(
    BLOCK_ID_ATTR,
    typeof requestedId === 'string' && requestedId ? requestedId : newBlockId()
  )
  if (input.attrs) {
    for (const [key, value] of Object.entries(input.attrs)) {
      if (key === BLOCK_ID_ATTR || key === 'caption' || key === 'source') continue
      if (value === null || value === undefined) continue
      attrs.set(key, value as string | number | boolean)
    }
  }
  const caption = typeof input.attrs?.caption === 'string' ? input.attrs.caption : ''
  if (isSyntaxFigureType(input.type)) {
    const source =
      typeof input.attrs?.source === 'string' && input.attrs.source
        ? input.attrs.source
        : (input.text ?? '')
    attrs.set('source', source)
    const loroText = getChildren(node).insertContainer(0, new LoroText())
    if (caption) loroText.insert(0, caption)
    return node
  }
  if (input.type === 'imageFigure') {
    const loroText = getChildren(node).insertContainer(0, new LoroText())
    if (caption) loroText.insert(0, caption)
    return node
  }
  if (isBlockContainerType(input.type)) {
    getChildren(node)
    return node
  }
  if (!isAtomType(input.type)) {
    const text = input.text ?? ''
    const loroText = getChildren(node).insertContainer(0, new LoroText())
    if (text.length > 0) {
      loroText.insert(0, text)
      for (const mark of input.marks ?? []) {
        const start = Math.max(0, mark.start ?? 0)
        const end = Math.min(text.length, mark.end ?? text.length)
        if (end > start) loroText.mark({ start, end }, mark.type, mark.attrs ?? {})
      }
    }
  }
  return node
}

/** Every blockId inside `node`, not counting `node` itself. */
export function descendantBlockIds(node: LoroMap): Set<BlockId> {
  const out = new Set<BlockId>()
  const walk = (parent: LoroMap): void => {
    const children = getChildren(parent)
    for (let i = 0; i < children.length; i += 1) {
      const child = children.get(i)
      if (!(child instanceof LoroMap)) continue
      const id = blockIdOf(child)
      if (id) out.add(id)
      walk(child)
    }
  }
  walk(node)
  return out
}

/** Removes a block from its parent. Returns false if it was already gone. */
export function deleteBlock(located: LocatedBlock): boolean {
  if (!located.parent) return false
  try {
    const children = getChildren(located.parent)
    const child = children.get(located.index)
    if (!isContainer(child)) return false
    children.delete(located.index, 1)
    return true
  } catch {
    // The parent was itself detached by an earlier delete in the same batch.
    return false
  }
}

export function blockIdFromCursor(
  doc: LoroDoc,
  cursor: Cursor
): { blockId: BlockId; offset: number } | null {
  let offset: number
  try {
    const pos = doc.getCursorPos(cursor)
    if (!pos) return null
    offset = pos.offset
  } catch {
    return null
  }
  const container = doc.getContainerById(cursor.containerId())
  if (!container) return null
  const node =
    container instanceof LoroText
      ? (container.parent()?.parent() as LoroMap | undefined)
      : container instanceof LoroList
        ? (container.parent() as LoroMap | undefined)
        : undefined
  if (!node) return null
  const blockId = blockIdOf(node)
  if (!blockId) return null
  return { blockId, offset }
}

export function cursorAt(node: LoroMap, offset: number): Cursor | undefined {
  const text = ensureText(node)
  const clamped = Math.max(0, Math.min(offset, text.length))
  return text.getCursor(clamped, 0) ?? undefined
}
