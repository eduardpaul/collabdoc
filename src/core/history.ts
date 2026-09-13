import { LoroDoc, LoroList, LoroMap, LoroText, type JsonOp, type PeerID } from 'loro-crdt'
import {
  ATTRIBUTES_KEY,
  AUTHORS_KEY,
  BLOCK_ID_ATTR,
  CHILDREN_KEY,
  COMMENTS_KEY,
  META_KEY,
  NODE_NAME_KEY,
  ROOT_DOC_KEY
} from '../shared/constants'
import { readAuthors, unknownAuthor, type HistoryAuthor } from './authors'

export type Frontier = { peer: PeerID; counter: number }

export type HistoryEntry = {
  id: string
  peer: string
  counter: number
  length: number
  lamport: number
  timestamp: number
  message: string
  summary: string
  details: string[]
  added: number
  removed: number
  author: HistoryAuthor
  frontiers: Frontier[]
  parentFrontiers: Frontier[]
}

export type HistoryBlock = { type: string; text: string; blockId?: string }

/**
 * Every change in the document, oldest first, attributed through the
 * `authors` map. Peers that never identified themselves are reported as
 * unknown rather than guessed.
 *
 * Walks `getAllChanges()` each time; 05 adds an incremental cache keyed by
 * frontier if this proves slow on long documents.
 */
export function listHistory(doc: LoroDoc): HistoryEntry[] {
  const authors = readAuthors(doc)
  const commentContainers = commentContainerIds(doc)
  const entries: HistoryEntry[] = []
  for (const [peer, changes] of doc.getAllChanges()) {
    for (const change of changes) {
      const described = describeChange(doc, peer, change.counter, change.length, commentContainers)
      if (described.details.length === 0 && !change.message) continue
      const author = authors[peer] ?? unknownAuthor(peer)
      const lastCounter = change.counter + Math.max(change.length, 1) - 1
      const { details, added, removed } = described
      const message = change.message ?? ''
      entries.push({
        id: `${change.counter}@${peer}`,
        peer,
        counter: change.counter,
        length: change.length,
        lamport: change.lamport,
        timestamp: normalizeTimestamp(change.timestamp),
        message,
        details,
        added,
        removed,
        summary: summarize(details, added, removed, message),
        author,
        frontiers: [{ peer: peer as PeerID, counter: lastCounter }],
        parentFrontiers: (change.deps ?? []).map((dep) => ({
          peer: dep.peer,
          counter: dep.counter
        }))
      })
    }
  }
  entries.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
    if (a.lamport !== b.lamport) return a.lamport - b.lamport
    return a.peer.localeCompare(b.peer)
  })
  return entries
}

/** The top-level blocks as they were at `frontiers`, on a throwaway fork. */
export function previewAt(doc: LoroDoc, frontiers: Frontier[]): HistoryBlock[] {
  if (frontiers.length === 0) return []
  try {
    return readBlocks(doc.forkAt(frontiers))
  } catch {
    return []
  }
}

export function livePreview(doc: LoroDoc): HistoryBlock[] {
  return readBlocks(doc)
}

/**
 * Thread maps and reply lists have their own container ids, so "is this op a
 * comment op" needs the set of containers under the `comments` root. Threads
 * are only ever soft-deleted, so walking the live map finds all of them.
 */
function commentContainerIds(doc: LoroDoc): Set<string> {
  const ids = new Set<string>()
  const root = doc.getMap(COMMENTS_KEY)
  ids.add(root.id)
  for (const key of root.keys()) {
    const thread = root.get(key)
    if (!(thread instanceof LoroMap)) continue
    ids.add(thread.id)
    const replies = thread.get('replies')
    if (replies instanceof LoroList) ids.add(replies.id)
  }
  return ids
}

function describeChange(
  doc: LoroDoc,
  peer: string,
  counter: number,
  length: number,
  commentContainers: Set<string>
): { details: string[]; added: number; removed: number } {
  let ops: JsonOp[] = []
  try {
    const changes = doc.exportJsonInIdSpan({
      peer: peer as PeerID,
      counter,
      length: Math.max(length, 1)
    })
    ops = changes.flatMap((change) => change.ops ?? [])
  } catch {
    return { details: [], added: 0, removed: 0 }
  }
  const lines: string[] = []
  let added = 0
  let removed = 0
  for (const op of ops) {
    const container = String(op.container)
    const content = op.content as Record<string, unknown>
    if (container.includes(AUTHORS_KEY)) continue
    if (container.includes(META_KEY)) {
      const line = describeMetaOp(content)
      if (line && !lines.includes(line)) lines.push(line)
      continue
    }
    if (commentContainers.has(container)) {
      const line = describeCommentOp(content)
      if (line && !lines.includes(line)) lines.push(line)
      continue
    }
    const isText = container.endsWith(':Text')
    if (content.type === 'insert' && typeof content.text === 'string') {
      added += content.text.length
    }
    if (
      content.type === 'insert' &&
      content.key === 'source' &&
      typeof content.value === 'string'
    ) {
      added += content.value.length
    }
    if (isText && content.type === 'delete' && typeof content.len === 'number') {
      removed += content.len
    }
    const line = describeOp(content, isText)
    if (line && !lines.includes(line)) lines.push(line)
  }
  return { details: lines.slice(0, 6), added, removed }
}

function summarize(details: string[], added: number, removed: number, message: string): string {
  const stat = formatStat(added, removed)
  const first = details[0] ?? (message || 'edited the document')
  return stat ? `${stat}  ${first}` : first
}

export function formatStat(added: number, removed: number): string {
  const parts: string[] = []
  if (added) parts.push(`+${added}`)
  if (removed) parts.push(`−${removed}`)
  return parts.join(' ')
}

function describeMetaOp(content: Record<string, unknown>): string | null {
  if (content.type === 'insert' && content.key === 'title' && typeof content.value === 'string') {
    return `set the title to “${clip(content.value, 72)}”`
  }
  return null
}

function describeCommentOp(content: Record<string, unknown>): string | null {
  if (content.type !== 'insert') return null
  if (content.key === 'body' && typeof content.value === 'string') {
    return content.value ? `commented “${clip(collapse(content.value), 72)}”` : 'deleted a comment'
  }
  if (content.key === 'status') {
    return content.value === 'resolved' ? 'resolved a thread' : 'reopened a thread'
  }
  if (typeof content.pos === 'number' && content.value && typeof content.value === 'object') {
    const body = (content.value as Record<string, unknown>).body
    return typeof body === 'string' && body ? `replied “${clip(collapse(body), 72)}”` : null
  }
  return null
}

function describeOp(content: Record<string, unknown>, isText: boolean): string | null {
  const type = content.type
  if (type === 'insert' && typeof content.text === 'string') {
    const text = collapse(content.text)
    return text ? `inserted “${clip(text, 72)}”` : null
  }
  if (type === 'delete' && typeof content.len === 'number' && typeof content.pos === 'number') {
    if (isText) return `deleted ${content.len} character${content.len === 1 ? '' : 's'}`
    return `removed ${content.len} block${content.len === 1 ? '' : 's'}`
  }
  if (type === 'mark' && typeof content.style_key === 'string') {
    return content.style_value == null
      ? `removed ${content.style_key}`
      : `applied ${content.style_key}`
  }
  if (type === 'insert' && content.key === NODE_NAME_KEY && typeof content.value === 'string') {
    return describeAddedNode(content.value)
  }
  if (type === 'insert' && content.key === 'source' && typeof content.value === 'string') {
    const text = collapse(content.value)
    return text ? `updated diagram “${clip(text, 72)}”` : 'updated diagram source'
  }
  if (type === 'insert' && typeof content.pos === 'number' && isContainerValue(content.value)) {
    return 'added a block'
  }
  return null
}

function describeAddedNode(name: string): string {
  if (name === 'mermaidFigure') return 'added a Mermaid diagram'
  if (name === 'infographicFigure') return 'added an Infographic'
  if (name === 'imageFigure') return 'added an image'
  return `added ${name}`
}

function isContainerValue(value: unknown): boolean {
  return typeof value === 'string' && (value.startsWith('🦜:') || value.startsWith('cid:'))
}

function readBlocks(doc: LoroDoc): HistoryBlock[] {
  const children = doc.getMap(ROOT_DOC_KEY).get(CHILDREN_KEY)
  if (!(children instanceof LoroList)) return []
  const blocks: HistoryBlock[] = []
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (!(child instanceof LoroMap)) continue
    const name = child.get(NODE_NAME_KEY)
    const type = typeof name === 'string' ? name : 'paragraph'
    const attrs = child.get(ATTRIBUTES_KEY)
    const blockId = attrs instanceof LoroMap ? attrs.get(BLOCK_ID_ATTR) : undefined
    blocks.push({
      type,
      text: historyBlockText(child, type),
      blockId: typeof blockId === 'string' ? blockId : undefined
    })
  }
  return blocks
}

function historyBlockText(node: LoroMap, type: string): string {
  const caption = plainText(node)
  if (type !== 'mermaidFigure' && type !== 'infographicFigure') return caption
  const attrs = node.get(ATTRIBUTES_KEY)
  const source =
    attrs instanceof LoroMap && typeof attrs.get('source') === 'string'
      ? (attrs.get('source') as string)
      : ''
  if (source && caption) return `${source}\n\n${caption}`
  return source || caption
}

function plainText(node: LoroMap): string {
  const children = node.get(CHILDREN_KEY)
  if (!(children instanceof LoroList)) return ''
  let out = ''
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroText) {
      out += child.toString()
      continue
    }
    if (child instanceof LoroMap) {
      const nested = plainText(child)
      if (!nested) continue
      out += out && !out.endsWith('\n') ? `\n${nested}` : nested
    }
  }
  return out
}

function normalizeTimestamp(value: number): number {
  if (!value) return 0
  return value > 1_000_000_000_000 ? value : value * 1000
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
