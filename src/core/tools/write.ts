import type { LoroMap } from 'loro-crdt'
import {
  ALLOWED_MARKS,
  ALLOWED_NODES,
  ASSET_SRC_PATTERN,
  BLOCK_ID_ATTR,
  FIGURE_ALIGNS,
  FIGURE_TYPES,
  FIGURE_WIDTHS,
  HEADING_LEVELS,
  NODE_NAME_KEY
} from '../../shared/constants'
import type { MutationErr, MutationResult, NodeInput, TextLocator } from '../../shared/types'
import { resolveRange, resolveRangeInString } from '../locators'
import {
  blockIdOf,
  createBlock,
  deleteBlock,
  descendantBlockIds,
  ensureText,
  findBlock,
  firstText,
  getAttrs,
  getChildren,
  getRoot,
  hasBlockChildren,
  isAtomType,
  isBlockContainer,
  isBlockContainerType,
  isSyntaxFigure,
  isSyntaxFigureType,
  nodeName,
  setCaption,
  setSyntaxSource,
  syntaxSourceOf,
  viewOf,
  type LocatedBlock
} from '../tree'
import { asRecord, asString, asStringArray, fail, type SessionContext } from './context'

export function isAllowedNode(type: string): boolean {
  return (ALLOWED_NODES as readonly string[]).includes(type)
}

export function isAllowedMark(type: string): boolean {
  return (ALLOWED_MARKS as readonly string[]).includes(type)
}

function isFigureType(type: string): boolean {
  return (FIGURE_TYPES as readonly string[]).includes(type)
}

/** Text tools work on blocks that hold text; figures route to their source. */
function textTarget(node: LoroMap): 'text' | 'source' | null {
  if (isSyntaxFigure(node)) return 'source'
  const type = nodeName(node)
  if (isAtomType(type) || isBlockContainerType(type)) return null
  return 'text'
}

/**
 * Attribute rules the editor also enforces, so a remote peer or an agent
 * cannot write attrs the renderer would have to sanitise.
 */
function checkAttrs(type: string, attrs: Record<string, unknown> | undefined): MutationErr | null {
  if (!attrs) return null
  if (type === 'heading' && attrs.level !== undefined && attrs.level !== null) {
    if (!(HEADING_LEVELS as readonly number[]).includes(Number(attrs.level))) {
      return fail('schema', `heading.level must be one of ${HEADING_LEVELS.join(', ')}.`)
    }
  }
  if (isFigureType(type)) {
    if (attrs.width !== undefined && attrs.width !== null) {
      if (!(FIGURE_WIDTHS as readonly number[]).includes(Number(attrs.width))) {
        return fail('schema', `Figure width must be one of ${FIGURE_WIDTHS.join(', ')}.`)
      }
    }
    if (
      attrs.align !== undefined &&
      !(FIGURE_ALIGNS as readonly string[]).includes(String(attrs.align))
    ) {
      return fail('schema', `Figure align must be one of ${FIGURE_ALIGNS.join(', ')}.`)
    }
    if (attrs.caption !== undefined && typeof attrs.caption !== 'string') {
      return fail('schema', 'Figure caption must be a string.')
    }
    if (attrs.style !== undefined) {
      return fail('schema', 'Figures take width and align, not a free-form style.')
    }
  }
  if (type === 'imageFigure' && attrs.src !== undefined) {
    if (typeof attrs.src !== 'string' || !ASSET_SRC_PATTERN.test(attrs.src)) {
      return fail(
        'schema',
        'imageFigure.src must reference an existing asset as `asset:<sha256>`; images cannot be created from data URIs or URLs.'
      )
    }
  }
  return null
}

function editSyntaxSource(
  ctx: SessionContext,
  node: LoroMap,
  blockId: string,
  options: {
    locator: TextLocator | undefined
    mode: 'span' | 'insert'
    replacement: string
    applied: string
  }
): MutationResult {
  const source = syntaxSourceOf(node)
  const resolved = resolveRangeInString(source, options.locator, options.mode)
  if (!resolved.ok) return fail('invalid_locator', resolved.message)
  const claimed = ctx.claimConflict(blockId)
  if (claimed) return claimed
  const { start, end } = resolved.range
  const next = source.slice(0, start) + options.replacement + source.slice(end)
  if (next.length > ctx.limits.maxInsertChars) {
    return fail('limit', `Diagram sources are limited to ${ctx.limits.maxInsertChars} characters.`)
  }
  return ctx.mutate(options.applied, () => {
    setSyntaxSource(node, next)
    return [node]
  })
}

export function insertText(ctx: SessionContext, args: Record<string, unknown>): MutationResult {
  const blockId = asString(args.blockId)
  const text = asString(args.text)
  if (!blockId || text == null) return fail('schema', 'blockId and text are required.')
  if (text.length === 0) return fail('schema', 'text must not be empty.')
  if (text.length > ctx.limits.maxInsertChars) {
    return fail('limit', `Inserts are limited to ${ctx.limits.maxInsertChars} characters.`)
  }
  const pre = ctx.prepareBlock(blockId, asString(args.view))
  if (!pre.ok) return pre
  const node = pre.found.node
  const target = textTarget(node)
  if (target === null) return fail('schema', `A ${nodeName(node)} holds no text.`)
  const locator = asRecord(args.at) as TextLocator | undefined

  if (target === 'source') {
    return editSyntaxSource(ctx, node, blockId, {
      locator,
      mode: 'insert',
      replacement: text,
      applied: `insert ${text.length} chars into diagram`
    })
  }

  const loroText = ensureText(node)
  const resolved = resolveRange(ctx.doc, loroText, locator, 'insert')
  if (!resolved.ok) return fail('invalid_locator', resolved.message)
  const claimed = ctx.claimConflict(blockId)
  if (claimed) return claimed

  const marks = Array.isArray(args.marks) ? args.marks : []
  for (const mark of marks) {
    const rec = asRecord(mark)
    if (!rec || typeof rec.type !== 'string' || !isAllowedMark(rec.type)) {
      return fail('schema', `Mark type is not allowed: ${String(rec?.type)}`)
    }
  }

  return ctx.mutate(`insert ${text.length} chars`, () => {
    loroText.insert(resolved.range.start, text)
    for (const mark of marks) {
      const rec = mark as { type: string; attrs?: Record<string, unknown> }
      loroText.mark(
        { start: resolved.range.start, end: resolved.range.start + text.length },
        rec.type,
        rec.attrs ?? {}
      )
    }
    return [node]
  })
}

export function replaceText(ctx: SessionContext, args: Record<string, unknown>): MutationResult {
  const blockId = asString(args.blockId)
  const text = asString(args.text)
  if (!blockId || text == null) return fail('schema', 'blockId and text are required.')
  if (text.length > ctx.limits.maxInsertChars) {
    return fail('limit', `Replacements are limited to ${ctx.limits.maxInsertChars} characters.`)
  }
  const pre = ctx.prepareBlock(blockId, asString(args.view))
  if (!pre.ok) return pre
  const node = pre.found.node
  const target = textTarget(node)
  if (target === null) return fail('schema', `A ${nodeName(node)} holds no text.`)
  const locator = asRecord(args.locator) as TextLocator | undefined

  if (target === 'source') {
    return editSyntaxSource(ctx, node, blockId, {
      locator,
      mode: 'span',
      replacement: text,
      applied: 'replace diagram source'
    })
  }

  const loroText = ensureText(node)
  const resolved = resolveRange(ctx.doc, loroText, locator, 'span')
  if (!resolved.ok) return fail('invalid_locator', resolved.message)
  const claimed = ctx.claimConflict(blockId)
  if (claimed) return claimed

  const { start, end } = resolved.range
  const previous = loroText.toString().slice(start, end)
  const clip = (value: string): string => (value.length > 40 ? `${value.slice(0, 39)}…` : value)
  return ctx.mutate(`replace_text in ${blockId}: "${clip(previous)}" → "${clip(text)}"`, () => {
    if (end > start) loroText.delete(start, end - start)
    if (text.length > 0) loroText.insert(start, text)
    return [node]
  })
}

export function applyMarks(ctx: SessionContext, args: Record<string, unknown>): MutationResult {
  const blockId = asString(args.blockId)
  if (!blockId) return fail('schema', 'blockId is required.')
  const marks = Array.isArray(args.marks) ? args.marks : []
  if (marks.length === 0) return fail('schema', 'marks is required.')

  const pre = ctx.prepareBlock(blockId, asString(args.view))
  if (!pre.ok) return pre
  const node = pre.found.node
  if (textTarget(node) !== 'text') {
    return fail('schema', `Marks cannot be applied to a ${nodeName(node)}.`)
  }
  const loroText = ensureText(node)

  const planned: Array<{
    op: 'add' | 'remove'
    type: string
    attrs: Record<string, unknown>
    start: number
    end: number
  }> = []
  for (const raw of marks) {
    const rec = asRecord(raw) as
      | { op?: string; type?: string; attrs?: Record<string, unknown>; range?: TextLocator }
      | undefined
    if (!rec || (rec.op !== 'add' && rec.op !== 'remove')) {
      return fail('schema', 'Each mark needs op add or remove.')
    }
    if (!rec.type || !isAllowedMark(rec.type)) {
      return fail('schema', `Mark type is not allowed: ${rec.type}`)
    }
    const resolved = resolveRange(ctx.doc, loroText, rec.range, 'span')
    if (!resolved.ok) return fail('invalid_locator', resolved.message)
    if (resolved.range.end <= resolved.range.start) {
      return fail('invalid_locator', 'Mark range is empty.')
    }
    planned.push({
      op: rec.op,
      type: rec.type,
      attrs: rec.attrs ?? {},
      start: resolved.range.start,
      end: resolved.range.end
    })
  }

  const claimed = ctx.claimConflict(blockId)
  if (claimed) return claimed

  return ctx.mutate('apply marks', () => {
    for (const mark of planned) {
      if (mark.op === 'add') {
        loroText.mark({ start: mark.start, end: mark.end }, mark.type, mark.attrs)
      } else {
        loroText.unmark({ start: mark.start, end: mark.end }, mark.type)
      }
    }
    return [node]
  })
}

export function insertBlocks(ctx: SessionContext, args: Record<string, unknown>): MutationResult {
  const blocks = Array.isArray(args.blocks) ? (args.blocks as NodeInput[]) : []
  if (blocks.length === 0) return fail('schema', 'blocks is required.')
  if (blocks.length > ctx.limits.maxBlocksPerCall) {
    return fail('limit', `At most ${ctx.limits.maxBlocksPerCall} blocks per call.`)
  }
  for (const block of blocks) {
    if (
      !block ||
      typeof block !== 'object' ||
      typeof block.type !== 'string' ||
      !isAllowedNode(block.type)
    ) {
      return fail('schema', `Node type is not allowed: ${String(block?.type)}`)
    }
    const attrs = asRecord(block.attrs)
    const bad = checkAttrs(block.type, attrs)
    if (bad) return bad
    if (block.type === 'imageFigure' && typeof attrs?.src !== 'string') {
      return fail(
        'schema',
        'imageFigure needs attrs.src with an existing `asset:<sha256>` reference.'
      )
    }
    const source =
      isSyntaxFigureType(block.type) && typeof attrs?.source === 'string' ? attrs.source : ''
    if ((block.text ?? source).length > ctx.limits.maxInsertChars) {
      return fail('limit', `Block text is limited to ${ctx.limits.maxInsertChars} characters.`)
    }
    for (const mark of block.marks ?? []) {
      if (!mark || typeof mark.type !== 'string' || !isAllowedMark(mark.type)) {
        return fail('schema', `Mark type is not allowed: ${String(mark?.type)}`)
      }
    }
  }

  const at = asRecord(args.at) as { relation?: string; blockId?: string } | undefined
  const relation = at?.relation ?? 'inside_end'
  if (!['before', 'after', 'inside_start', 'inside_end'].includes(relation)) {
    return fail('schema', `Unknown relation: ${relation}`)
  }
  let parent = getRoot(ctx.doc)
  let index = getChildren(parent).length

  if (at?.blockId) {
    const found = findBlock(ctx.doc, at.blockId)
    if (!found) return fail('not_found', `Block ${at.blockId} was not found.`)
    if (relation === 'inside_start' || relation === 'inside_end') {
      if (!isBlockContainer(found.node)) {
        return fail(
          'schema',
          `Block ${at.blockId} is a ${nodeName(found.node)} and holds text, not blocks. ` +
            'Use relation "before" or "after" to place a block next to it.'
        )
      }
      parent = found.node
      index = relation === 'inside_start' ? 0 : getChildren(parent).length
    } else if (found.parent) {
      parent = found.parent
      index = relation === 'before' ? found.index : found.index + 1
    }
    const claimed = ctx.claimConflict(at.blockId)
    if (claimed && (relation === 'inside_start' || relation === 'inside_end')) return claimed
  } else if (relation === 'inside_start') {
    index = 0
  }

  return ctx.mutate(`insert ${blocks.length} block(s)`, () => {
    const created: LoroMap[] = []
    for (let i = 0; i < blocks.length; i += 1) {
      created.push(createBlock(parent, index + i, blocks[i]))
    }
    return created
  })
}

export function updateBlock(ctx: SessionContext, args: Record<string, unknown>): MutationResult {
  const blockId = asString(args.blockId)
  if (!blockId) return fail('schema', 'blockId is required.')
  const pre = ctx.prepareBlock(blockId, asString(args.view))
  if (!pre.ok) return pre
  const node = pre.found.node
  const currentType = nodeName(node)

  const nextType = asString(args.type)
  if (nextType && !isAllowedNode(nextType)) {
    return fail('schema', `Node type is not allowed: ${nextType}`)
  }
  if (nextType && nextType !== currentType) {
    const structural = (type: string): boolean => isFigureType(type) || isAtomType(type)
    if (structural(nextType) || structural(currentType)) {
      return fail(
        'schema',
        `A ${currentType} cannot become a ${nextType}. Delete it and insert a new block instead.`
      )
    }
    if (!isBlockContainerType(nextType) && hasBlockChildren(node)) {
      return fail(
        'schema',
        `Block ${blockId} holds blocks, so it cannot become a ${nextType}. Move or delete its children first.`
      )
    }
    if (
      isBlockContainerType(nextType) &&
      !isBlockContainerType(currentType) &&
      (firstText(node)?.length ?? 0) > 0
    ) {
      return fail('schema', `A ${currentType} with text cannot become a ${nextType}.`)
    }
  }
  const effectiveType = nextType ?? currentType
  const attrs = asRecord(args.attrs)
  const bad = checkAttrs(effectiveType, attrs)
  if (bad) return bad
  if (attrs?.source !== undefined) {
    if (!isSyntaxFigureType(effectiveType)) {
      return fail('schema', 'Only mermaidFigure and infographicFigure have a source.')
    }
    if (typeof attrs.source !== 'string') return fail('schema', 'source must be a string.')
    if (attrs.source.length > ctx.limits.maxInsertChars) {
      return fail(
        'limit',
        `Diagram sources are limited to ${ctx.limits.maxInsertChars} characters.`
      )
    }
  }
  if (attrs?.caption !== undefined && !isFigureType(effectiveType)) {
    return fail('schema', 'Only figures have a caption.')
  }
  const claimed = ctx.claimConflict(blockId)
  if (claimed) return claimed

  return ctx.mutate('update block', () => {
    if (nextType) node.set(NODE_NAME_KEY, nextType)
    if (attrs) {
      const attrMap = getAttrs(node)
      for (const [key, value] of Object.entries(attrs)) {
        if (key === BLOCK_ID_ATTR) continue
        if (key === 'caption') {
          setCaption(node, typeof value === 'string' ? value : '')
          continue
        }
        if (value === null || value === undefined) attrMap.delete(key)
        else attrMap.set(key, value as string | number | boolean)
      }
    }
    return [node]
  })
}

export function deleteBlocks(ctx: SessionContext, args: Record<string, unknown>): MutationResult {
  const ids = asStringArray(args.blockIds)
  if (!ids || ids.length === 0) return fail('schema', 'blockIds is required.')
  if (ids.length > ctx.limits.maxBlocksPerCall) {
    return fail('limit', `At most ${ctx.limits.maxBlocksPerCall} blocks per call.`)
  }
  const view = asString(args.view)
  const located: LocatedBlock[] = []
  for (const id of ids) {
    const found = findBlock(ctx.doc, id)
    if (!found) return fail('not_found', `Block ${id} was not found.`)
    if (view && ids.length === 1 && viewOf(found.node) !== view) {
      return fail('conflict', 'Block changed since it was last read. Re-read and retry.')
    }
    const claimed = ctx.claimConflict(id)
    if (claimed) return claimed
    located.push(found)
  }
  // Deleting a block takes its whole subtree with it. If the caller also
  // named one of those descendants, the second delete would reach through a
  // parent that no longer exists, so drop the nested ids up front.
  const nested = new Set<string>()
  for (const item of located) {
    const id = blockIdOf(item.node)
    for (const child of descendantBlockIds(item.node)) {
      if (child !== id) nested.add(child)
    }
  }
  const roots = located.filter((item) => {
    const id = blockIdOf(item.node)
    return !id || !nested.has(id)
  })
  // Within one parent, deleting high indexes first keeps the lower ones
  // valid; indexes in different parents are independent, so one descending
  // sort covers every parent at once.
  roots.sort((a, b) => b.index - a.index)
  return ctx.mutate(`delete ${ids.length} block(s)`, () => {
    for (const item of roots) deleteBlock(item)
    return []
  })
}
