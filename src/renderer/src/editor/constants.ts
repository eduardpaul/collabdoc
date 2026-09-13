export const BLOCK_ID_ATTR = 'blockId'

export const ALLOWED_NODES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'imageFigure',
  'mermaidFigure',
  'infographicFigure'
] as const

export const ALLOWED_MARKS = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
  'highlight',
  'superscript',
  'subscript'
] as const

export const BLOCK_ID_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'taskItem',
  'horizontalRule',
  'imageFigure',
  'mermaidFigure',
  'infographicFigure'
] as const

export const FIGURE_TYPES = ['imageFigure', 'mermaidFigure', 'infographicFigure'] as const
export const SYNTAX_FIGURE_TYPES = ['mermaidFigure', 'infographicFigure'] as const

export const FIGURE_WIDTHS = [50, 75, 100] as const
export const FIGURE_ALIGNS = ['left', 'center', 'right'] as const

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_DOCUMENT_ASSET_BYTES = 25 * 1024 * 1024

export type FigureWidth = (typeof FIGURE_WIDTHS)[number]
export type FigureAlign = (typeof FIGURE_ALIGNS)[number]

export const HEADING_LEVELS = [1, 2, 3, 4] as const

/**
 * How a mark behaves when text is typed at its edge.
 *
 * `loro-prosemirror` will derive the same config from the ProseMirror schema
 * (`inclusive !== false` → `"after"`). This table and the Tiptap extensions
 * must agree, or the same edit marks up differently depending on who made it.
 *
 * `link` expands because Tiptap's Link mark is inclusive whenever autolink is
 * on, and autolink is on.
 */
export const TEXT_STYLE_CONFIG = {
  bold: { expand: 'after' as const },
  italic: { expand: 'after' as const },
  underline: { expand: 'after' as const },
  strike: { expand: 'after' as const },
  code: { expand: 'none' as const },
  link: { expand: 'after' as const },
  highlight: { expand: 'none' as const },
  superscript: { expand: 'none' as const },
  subscript: { expand: 'none' as const }
}

export type TextStyleExpand = 'after' | 'none'
export type AllowedNode = (typeof ALLOWED_NODES)[number]
export type AllowedMark = (typeof ALLOWED_MARKS)[number]
export type HeadingLevel = (typeof HEADING_LEVELS)[number]
