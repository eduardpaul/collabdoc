import type {
  BlocksResult,
  BlockView,
  MutationErr,
  OutlineResult,
  SearchHit,
  SearchResult
} from '../../shared/types'
import { allBlocks, blockAgentText, blockIdOf, findBlock, outline, toBlockView } from '../tree'
import { asString, asStringArray, fail, type SessionContext } from './context'

export function getDocument(ctx: SessionContext, args: Record<string, unknown>): OutlineResult {
  const raw = typeof args.maxPreviewChars === 'number' ? args.maxPreviewChars : 80
  const maxPreviewChars = Math.max(0, Math.min(200, Math.floor(raw)))
  return { blocks: outline(ctx.doc, maxPreviewChars) }
}

export function getBlocks(
  ctx: SessionContext,
  args: Record<string, unknown>
): BlocksResult | MutationErr {
  const ids = asStringArray(args.blockIds)
  if (!ids || ids.length === 0) return fail('schema', 'blockIds is required.')
  if (ids.length > ctx.limits.maxBlocksPerRead) {
    return fail('limit', `At most ${ctx.limits.maxBlocksPerRead} blocks per read.`)
  }
  const blocks: BlockView[] = []
  for (const id of ids) {
    const found = findBlock(ctx.doc, id)
    if (!found) return fail('not_found', `Block ${id} was not found.`)
    const view = toBlockView(found.node)
    if (view) blocks.push(view)
  }
  return { blocks }
}

export function search(
  ctx: SessionContext,
  args: Record<string, unknown>
): SearchResult | MutationErr {
  const query = asString(args.query) ?? ''
  if (!query) return fail('schema', 'query is required.')
  const requested = typeof args.maxResults === 'number' ? Math.floor(args.maxResults) : 20
  const maxResults = Math.max(1, Math.min(requested, ctx.limits.maxSearchResults))
  const only = asString(args.blockId) ?? null
  const hits: SearchHit[] = []
  for (const located of allBlocks(ctx.doc)) {
    const id = blockIdOf(located.node)
    if (!id) continue
    if (only && id !== only) continue
    const text = blockAgentText(located.node)
    let from = 0
    let occurrence = 0
    while (hits.length < maxResults) {
      const idx = text.indexOf(query, from)
      if (idx < 0) break
      occurrence += 1
      const snippetStart = Math.max(0, idx - 24)
      const snippetEnd = Math.min(text.length, idx + query.length + 24)
      hits.push({
        blockId: id,
        snippet: text.slice(snippetStart, snippetEnd),
        locator: { find: query, occurrence }
      })
      from = idx + Math.max(query.length, 1)
    }
    if (hits.length >= maxResults) break
  }
  return { hits }
}
