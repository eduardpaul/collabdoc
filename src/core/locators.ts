import type { LoroDoc, LoroText } from 'loro-crdt'
import type { TextLocator } from '../shared/types'
import { decodeAnchor } from './anchors'

export type ResolvedRange = { start: number; end: number }
export type Resolution = { ok: true; range: ResolvedRange } | { ok: false; message: string }

function nthIndex(haystack: string, needle: string, occurrence: number): number {
  if (!needle) return -1
  let from = 0
  for (let i = 1; i <= occurrence; i += 1) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) return -1
    if (i === occurrence) return idx
    from = idx + needle.length
  }
  return -1
}

function isEmptyLocator(locator: TextLocator | undefined): locator is undefined {
  return !locator || Object.values(locator).every((value) => value === undefined)
}

/**
 * Resolve a locator against a plain string. Used for figure sources (which
 * are attribute strings, not `LoroText`) and as the fallback for text blocks.
 */
export function resolveRangeInString(
  content: string,
  locator: TextLocator | undefined,
  mode: 'span' | 'insert'
): Resolution {
  const occurrence = locator?.occurrence ?? 1

  if (isEmptyLocator(locator)) {
    if (mode === 'insert') {
      return { ok: true, range: { start: content.length, end: content.length } }
    }
    return { ok: false, message: 'A locator is required for this edit.' }
  }

  if (locator.find != null) {
    const idx = nthIndex(content, locator.find, occurrence)
    if (idx < 0) {
      return { ok: false, message: `Could not find occurrence ${occurrence} of "${locator.find}".` }
    }
    return { ok: true, range: { start: idx, end: idx + locator.find.length } }
  }

  if (locator.after != null) {
    const idx = nthIndex(content, locator.after, occurrence)
    if (idx < 0) return { ok: false, message: `Could not find "${locator.after}".` }
    const at = idx + locator.after.length
    return { ok: true, range: { start: at, end: at } }
  }

  if (locator.before != null) {
    const idx = nthIndex(content, locator.before, occurrence)
    if (idx < 0) return { ok: false, message: `Could not find "${locator.before}".` }
    return { ok: true, range: { start: idx, end: idx } }
  }

  if (locator.start != null) {
    const start = locator.start
    const end = locator.end ?? (mode === 'insert' ? start : content.length)
    if (start < 0 || end < start || end > content.length) {
      return { ok: false, message: 'Offsets are out of range for this block.' }
    }
    if (locator.expected != null) {
      const actual = content.slice(start, end)
      if (actual !== locator.expected) {
        return { ok: false, message: `Expected "${locator.expected}" but found "${actual}".` }
      }
    } else if (mode === 'span') {
      return { ok: false, message: 'Numeric offsets require an `expected` snapshot of that span.' }
    }
    return { ok: true, range: { start, end } }
  }

  if (mode === 'insert') {
    return { ok: true, range: { start: content.length, end: content.length } }
  }

  return { ok: false, message: 'Could not resolve locator.' }
}

/**
 * Resolve a locator against a `LoroText`, honouring `anchor`s — stable
 * positions that follow the text through concurrent edits.
 */
export function resolveRange(
  doc: LoroDoc,
  text: LoroText,
  locator: TextLocator | undefined,
  mode: 'span' | 'insert'
): Resolution {
  const content = text.toString()

  if (locator?.anchor) {
    let start: number
    try {
      const cursor = decodeAnchor(locator.anchor)
      if (cursor.containerId() !== text.id) {
        return { ok: false, message: 'Anchor belongs to a different block.' }
      }
      const pos = doc.getCursorPos(cursor)
      if (!pos) return { ok: false, message: 'Anchor no longer resolves in this document.' }
      start = pos.offset
    } catch {
      return { ok: false, message: 'Anchor no longer resolves in this document.' }
    }
    if (start < 0 || start > content.length) {
      return { ok: false, message: 'Anchor points outside this block.' }
    }
    if (mode === 'insert') {
      return { ok: true, range: { start, end: start } }
    }

    // An anchor is a single point. Replacing needs a span, so the caller has
    // to say how far it reaches — via `length`, `end`, or an `expected`
    // snapshot. Without one there is no span, and silently using an empty
    // range would turn every anchored replace_text into an insert.
    const span =
      locator.length ??
      (locator.end != null
        ? locator.end - start
        : locator.expected != null
          ? locator.expected.length
          : null)
    if (span == null) {
      return {
        ok: false,
        message:
          'An anchor marks one position. To replace text, also pass `length`, `end`, or ' +
          '`expected` — or use `find` with the exact text.'
      }
    }
    if (span <= 0) {
      return { ok: false, message: 'The anchored span is empty.' }
    }
    const end = Math.min(start + span, content.length)
    if (locator.expected != null) {
      const actual = content.slice(start, end)
      if (actual !== locator.expected) {
        return { ok: false, message: `Expected "${locator.expected}" but found "${actual}".` }
      }
    }
    return { ok: true, range: { start, end } }
  }

  return resolveRangeInString(content, locator, mode)
}
