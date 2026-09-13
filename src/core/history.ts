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
import type { AuthorRecord } from '../shared/types'
import { readAuthors, unknownAuthor, type HistoryAuthor } from './authors'
import { allBlocks, blockIdOf, firstText, getAttrs, getChildren } from './tree'

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
  blockIds: string[]
}

export type HistoryBlock = { type: string; text: string; blockId?: string }

/**
 * Every change in the document, oldest first, attributed through the
 * `authors` map. Peers that never identified themselves are reported as
 * unknown rather than guessed.
 *
 * Walks `getAllChanges()` each time. The History tab uses `HistoryIndex`
 * (05) so new commits are appended without re-describing old ones.
 */
export function listHistory(doc: LoroDoc): HistoryEntry[] {
  const authors = readAuthors(doc)
  const commentContainers = commentContainerIds(doc)
  const containers = containerToBlockId(doc)
  const entries: HistoryEntry[] = []
  for (const [peer, changes] of doc.getAllChanges()) {
    for (const change of changes) {
      const entry = entryFromChange(doc, peer, change, authors, commentContainers, containers)
      if (entry) entries.push(entry)
    }
  }
  entries.sort(compareHistory)
  return entries
}

export type ChangeLike = {
  counter: number
  length: number
  lamport: number
  timestamp: number
  message?: string
  deps?: Frontier[]
}

export function entryFromChange(
  doc: LoroDoc,
  peer: string,
  change: ChangeLike,
  authors: Record<string, AuthorRecord>,
  commentContainers: Set<string>,
  containers: Map<string, string>
): HistoryEntry | null {
  const described = describeChange(
    doc,
    peer,
    change.counter,
    change.length,
    commentContainers,
    containers
  )
  if (described.details.length === 0 && !change.message) return null
  const author = authors[peer] ?? unknownAuthor(peer)
  const lastCounter = change.counter + Math.max(change.length, 1) - 1
  const { details, added, removed, blockIds } = described
  const message = change.message ?? ''
  return {
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
    })),
    blockIds
  }
}

export function compareHistory(a: HistoryEntry, b: HistoryEntry): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  return a.peer.localeCompare(b.peer)
}

export function commentContainerIds(doc: LoroDoc): Set<string> {
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

/** Map every live container id (node, attrs, children, text) to its blockId. */
export function containerToBlockId(doc: LoroDoc): Map<string, string> {
  const map = new Map<string, string>()
  for (const { node } of allBlocks(doc)) {
    const blockId = blockIdOf(node)
    if (!blockId) continue
    map.set(node.id, blockId)
    map.set(getAttrs(node).id, blockId)
    map.set(getChildren(node).id, blockId)
    const text = firstText(node)
    if (text) map.set(text.id, blockId)
  }
  return map
}

export function filterHistory(
  entries: HistoryEntry[],
  options: { actorId?: string; query?: string } = {}
): HistoryEntry[] {
  const query = options.query?.trim().toLowerCase() ?? ''
  return entries.filter((entry) => {
    if (options.actorId && entry.author.actorId !== options.actorId) return false
    if (!query) return true
    return (
      entry.summary.toLowerCase().includes(query) ||
      entry.message.toLowerCase().includes(query) ||
      entry.author.name.toLowerCase().includes(query)
    )
  })
}

export function authorCounts(entries: HistoryEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const id = entry.author.actorId
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
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

function describeChange(
  doc: LoroDoc,
  peer: string,
  counter: number,
  length: number,
  commentContainers: Set<string>,
  containers: Map<string, string>
): { details: string[]; added: number; removed: number; blockIds: string[] } {
  let ops: JsonOp[] = []
  try {
    const changes = doc.exportJsonInIdSpan({
      peer: peer as PeerID,
      counter,
      length: Math.max(length, 1)
    })
    ops = changes.flatMap((change) => change.ops ?? [])
  } catch {
    return { details: [], added: 0, removed: 0, blockIds: [] }
  }
  const lines: string[] = []
  const blockIds: string[] = []
  let added = 0
  let removed = 0
  for (const op of ops) {
    const container = String(op.container)
    const content = op.content as Record<string, unknown>
    const blockId = containers.get(container)
    if (blockId && !blockIds.includes(blockId)) blockIds.push(blockId)
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
  return { details: lines.slice(0, 6), added, removed, blockIds }
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
