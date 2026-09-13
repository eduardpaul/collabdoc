import type { LoroDoc } from 'loro-crdt'
import { HISTORY_DIFF_CACHE } from '../shared/constants'
import { livePreview, previewAt, type HistoryBlock, type HistoryEntry } from './history'

export type DiffPart = { type: 'add' | 'remove' | 'same'; text: string }

export type DiffHunk = {
  kind: 'add' | 'remove' | 'change' | 'same'
  blockId?: string
  type: string
  before: string
  after: string
  parts: DiffPart[]
}

const cache = new Map<string, DiffHunk[]>()

/** Word-level per-block diff of one commit. Cached for the last N entries. */
export function diffChange(doc: LoroDoc, entry: HistoryEntry): DiffHunk[] {
  const cached = cache.get(entry.id)
  if (cached) return cached
  const before = previewAt(doc, entry.parentFrontiers)
  const after = previewAt(doc, entry.frontiers)
  const hunks = diffBlocks(before, after)
  if (cache.size >= HISTORY_DIFF_CACHE) {
    const first = cache.keys().next().value
    if (first) cache.delete(first)
  }
  cache.set(entry.id, hunks)
  return hunks
}

export function diffAgainstLive(doc: LoroDoc, entry: HistoryEntry): DiffHunk[] {
  return diffBlocks(livePreview(doc), previewAt(doc, entry.frontiers))
}

export function diffBlocks(before: HistoryBlock[], after: HistoryBlock[]): DiffHunk[] {
  const afterById = new Map(after.filter((b) => b.blockId).map((b) => [b.blockId!, b]))
  const beforeById = new Map(before.filter((b) => b.blockId).map((b) => [b.blockId!, b]))
  const seen = new Set<string>()
  const hunks: DiffHunk[] = []

  for (const block of before) {
    const id = block.blockId
    const next = id ? afterById.get(id) : undefined
    if (id) seen.add(id)
    if (!next) {
      hunks.push(hunk('remove', block, ''))
      continue
    }
    if (next.text === block.text && next.type === block.type) {
      hunks.push(hunk('same', block, next.text))
      continue
    }
    hunks.push(hunk('change', block, next.text, next.type))
  }
  for (const block of after) {
    const id = block.blockId
    if (id && (seen.has(id) || beforeById.has(id))) continue
    hunks.push(hunk('add', block, block.text))
  }
  return withContext(hunks)
}

export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ type: 'same', text: before }] : []
  if (!before) return after ? [{ type: 'add', text: after }] : []
  if (!after) return [{ type: 'remove', text: before }]
  const a = tokenize(before)
  const b = tokenize(after)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const parts: DiffPart[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushPart(parts, 'same', a[i])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushPart(parts, 'remove', a[i])
      i += 1
    } else {
      pushPart(parts, 'add', b[j])
      j += 1
    }
  }
  while (i < n) {
    pushPart(parts, 'remove', a[i])
    i += 1
  }
  while (j < m) {
    pushPart(parts, 'add', b[j])
    j += 1
  }
  return parts
}

function hunk(kind: DiffHunk['kind'], block: HistoryBlock, after: string, type?: string): DiffHunk {
  const before = kind === 'add' ? '' : block.text
  const next = kind === 'remove' ? '' : after
  return {
    kind,
    blockId: block.blockId,
    type: type ?? block.type,
    before,
    after: next,
    parts: kind === 'same' ? [{ type: 'same', text: next }] : diffWords(before, next)
  }
}

function withContext(hunks: DiffHunk[]): DiffHunk[] {
  const keep = new Set<number>()
  hunks.forEach((hunk, i) => {
    if (hunk.kind === 'same') return
    keep.add(i)
    if (i > 0) keep.add(i - 1)
    if (i + 1 < hunks.length) keep.add(i + 1)
  })
  if (keep.size === 0) return hunks.slice(0, 1)
  return hunks.filter((_, i) => keep.has(i))
}

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part.length > 0)
}

function pushPart(parts: DiffPart[], type: DiffPart['type'], text: string): void {
  const last = parts[parts.length - 1]
  if (last && last.type === type) {
    last.text += text
    return
  }
  parts.push({ type, text })
}
