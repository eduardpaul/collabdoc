import type { ToolName } from './types'

export const TOOL_NAMES: readonly ToolName[] = [
  'get_document',
  'get_blocks',
  'search',
  'insert_text',
  'replace_text',
  'apply_marks',
  'insert_blocks',
  'update_block',
  'delete_blocks',
  'undo',
  'redo',
  'set_presence',
  'get_presence',
  'add_comment',
  'reply_comment',
  'resolve_comment',
  'list_comments'
]

export const READ_TOOLS: readonly ToolName[] = ['get_document', 'get_blocks', 'search']

export const COMMENT_TOOLS: readonly ToolName[] = [
  'add_comment',
  'reply_comment',
  'resolve_comment',
  'list_comments'
]

export const TEXT_TOOLS: readonly ToolName[] = [
  'insert_text',
  'replace_text',
  'apply_marks',
  'insert_blocks',
  'update_block',
  'delete_blocks',
  'undo',
  'redo'
]

/** Reviewers read and talk; they never touch the text. */
export const REVIEWER_TOOLS: readonly ToolName[] = [...READ_TOOLS, 'get_presence', ...COMMENT_TOOLS]

export const WRITER_TOOLS: readonly ToolName[] = [
  ...READ_TOOLS,
  ...TEXT_TOOLS,
  'set_presence',
  'get_presence',
  ...COMMENT_TOOLS
]

export function toolsForRole(role: 'writer' | 'reviewer'): readonly ToolName[] {
  return role === 'writer' ? WRITER_TOOLS : REVIEWER_TOOLS
}

/**
 * Tools that change the document (text or comment sidecar). The runtime uses
 * this to tell "the agent ran and wrote something" apart from "the agent ran
 * and did nothing".
 */
export const DOCUMENT_WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  ...TEXT_TOOLS,
  'add_comment',
  'reply_comment',
  'resolve_comment'
])

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value)
}

/** One shared paragraph about figures, reused by every tool that touches them. */
export const FIGURE_CONVENTIONS =
  'Figures: for mermaidFigure and infographicFigure, `text` is the diagram source and the ' +
  'caption is `attrs.caption`. An imageFigure has no text; its `attrs.src` must be an ' +
  'existing `asset:<sha256>` reference (images cannot be created from data URIs) and its ' +
  'caption is `attrs.caption`.'

const LOCATOR_SCHEMA = {
  type: 'object',
  description:
    'Where in the block text. Use `find` (exact text, plus `occurrence` for the nth match), ' +
    '`after`/`before` (insert next to text), or `anchor` from a previous read (plus `length` ' +
    'or `expected` to make a span).',
  properties: {
    find: { type: 'string' },
    occurrence: { type: 'integer', minimum: 1 },
    after: { type: 'string' },
    before: { type: 'string' },
    start: { type: 'integer', minimum: 0 },
    end: { type: 'integer', minimum: 0 },
    expected: { type: 'string' },
    anchor: { type: 'string' },
    length: { type: 'integer', minimum: 1 }
  },
  additionalProperties: false
} as const

export type ToolDefinition = {
  name: ToolName
  description: string
  parameters: Record<string, unknown>
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'get_document',
    description:
      'Return the document outline: block ids, types, and short text previews. Use this before ' +
      'editing. Do not assume offsets from a previous turn still hold.',
    parameters: {
      type: 'object',
      properties: {
        maxPreviewChars: { type: 'integer', minimum: 0, maximum: 200, default: 80 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_blocks',
    description:
      'Read full text, marks, and attrs for specific blocks. Always re-read a block before ' +
      `replacing text in it. ${FIGURE_CONVENTIONS}`,
    parameters: {
      type: 'object',
      required: ['blockIds'],
      properties: {
        blockIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } }
      },
      additionalProperties: false
    }
  },
  {
    name: 'search',
    description:
      'Find text in the document. Returns block ids, snippets, and locators you can pass to ' +
      'replace/delete tools.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        blockId: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'insert_text',
    description:
      'Insert text inside one block without rewriting the block. Prefer this over replace for ' +
      `additive edits. Fails if the locator no longer matches. ${FIGURE_CONVENTIONS}`,
    parameters: {
      type: 'object',
      required: ['blockId', 'text'],
      properties: {
        blockId: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 8000 },
        at: LOCATOR_SCHEMA,
        marks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type'],
            properties: { type: { type: 'string' }, attrs: { type: 'object' } }
          }
        },
        view: { type: 'string' },
        reason: { type: 'string', maxLength: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'replace_text',
    description:
      'Replace a precise span inside one block. You must identify the existing text (find or ' +
      `expected). Will not apply if that span has changed. ${FIGURE_CONVENTIONS}`,
    parameters: {
      type: 'object',
      required: ['blockId', 'locator', 'text'],
      properties: {
        blockId: { type: 'string' },
        locator: LOCATOR_SCHEMA,
        text: { type: 'string', maxLength: 8000 },
        view: { type: 'string' },
        reason: { type: 'string', maxLength: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'apply_marks',
    description:
      'Add or remove marks on a span inside one block. Does not change the underlying ' +
      'characters. Not available on figures.',
    parameters: {
      type: 'object',
      required: ['blockId', 'marks'],
      properties: {
        blockId: { type: 'string' },
        marks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['type', 'op'],
            properties: {
              op: { enum: ['add', 'remove'] },
              type: { type: 'string' },
              attrs: { type: 'object' },
              range: LOCATOR_SCHEMA
            }
          }
        },
        view: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'insert_blocks',
    description:
      'Insert one or more blocks relative to an existing block. The host assigns block ids. ' +
      'Only schema-valid node types are allowed; blocks can only be nested inside blockquote ' +
      `and list items. ${FIGURE_CONVENTIONS}`,
    parameters: {
      type: 'object',
      required: ['blocks', 'at'],
      properties: {
        blocks: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string' },
              attrs: { type: 'object' },
              text: { type: 'string' },
              marks: { type: 'array', items: { type: 'object' } }
            }
          }
        },
        at: {
          type: 'object',
          required: ['relation'],
          properties: {
            relation: { enum: ['before', 'after', 'inside_start', 'inside_end'] },
            blockId: { type: 'string' }
          }
        },
        reason: { type: 'string', maxLength: 200 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'update_block',
    description:
      "Change a block's type and/or attributes in place. Does not replace its text or " +
      `children. ${FIGURE_CONVENTIONS}`,
    parameters: {
      type: 'object',
      required: ['blockId'],
      properties: {
        blockId: { type: 'string' },
        type: { type: 'string' },
        attrs: { type: 'object' },
        view: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'delete_blocks',
    description:
      'Delete whole blocks. Prefer replace_text for deleting a sentence inside a paragraph.',
    parameters: {
      type: 'object',
      required: ['blockIds'],
      properties: {
        blockIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
        view: { type: 'string' },
        reason: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'undo',
    description: 'Undo your last successful edit step only. Does not undo other participants.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'redo',
    description: 'Redo your last undone edit step.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_presence',
    description:
      'Publish your cursor and optionally claim blocks you intend to edit. Claims are advisory ' +
      'hints that expire: other participants see them, and some sessions refuse to write into ' +
      'a claimed block, but a claim is never a lock. Always re-read before you write.',
    parameters: {
      type: 'object',
      properties: {
        cursor: {
          type: 'object',
          required: ['blockId'],
          properties: { blockId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }
        },
        claimBlockIds: { type: 'array', items: { type: 'string' } },
        claimSeconds: { type: 'integer', minimum: 5, maximum: 120, default: 30 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_presence',
    description:
      'List the people and agents currently in the document, their cursors, and claimed blocks.',
    parameters: {
      type: 'object',
      properties: { nearBlockId: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'add_comment',
    description:
      'Open a comment thread on a span inside one block. Does not change the document text. ' +
      'Prefer a locator that quotes the exact phrase you are commenting on; omit it to comment ' +
      'on the whole block. Mention a participant with @handle to ask them something.',
    parameters: {
      type: 'object',
      required: ['blockId', 'body'],
      properties: {
        blockId: { type: 'string' },
        body: { type: 'string', minLength: 1, maxLength: 2000 },
        locator: LOCATOR_SCHEMA
      },
      additionalProperties: false
    }
  },
  {
    name: 'reply_comment',
    description:
      'Reply in an existing comment thread. Use this to answer a question addressed to you.',
    parameters: {
      type: 'object',
      required: ['threadId', 'body'],
      properties: {
        threadId: { type: 'string' },
        body: { type: 'string', minLength: 1, maxLength: 2000 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'resolve_comment',
    description:
      'Mark a comment thread as resolved. Anyone can resolve a thread; say why in `reason` ' +
      'when it is not obvious.',
    parameters: {
      type: 'object',
      required: ['threadId'],
      properties: {
        threadId: { type: 'string' },
        reason: { type: 'string', maxLength: 500 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_comments',
    description:
      'List comment threads with their replies. Defaults to open threads. Pass ' +
      '`mentioning: "me"` to find threads that address you. Use this to avoid stacking the ' +
      'same note twice.',
    parameters: {
      type: 'object',
      properties: {
        blockId: { type: 'string' },
        status: { enum: ['open', 'resolved', 'all'] },
        mentioning: { enum: ['me'] }
      },
      additionalProperties: false
    }
  }
]
