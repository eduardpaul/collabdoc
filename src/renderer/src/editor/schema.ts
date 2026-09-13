import type { AnyExtension } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import TextAlign from '@tiptap/extension-text-align'
import Typography from '@tiptap/extension-typography'
import StarterKit from '@tiptap/starter-kit'
import { BlockId, DedupeBlockIds } from './block-id'
import { HEADING_LEVELS } from './constants'
import { FigureCaptionKeys } from './figures/caption'
import { ImageFigure } from './figures/image-figure'
import { InfographicFigure } from './figures/infographic'
import { MermaidFigure } from './figures/mermaid'
import { MarkdownSubscript, MarkdownSuperscript, MarkdownUnderline } from './markdown-marks'

/** Undo is Loro's (`LoroUndoPlugin`); Tiptap's history must stay off. */
export const ENABLE_TIPTAP_HISTORY = false

export function schemaExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      undoRedo: ENABLE_TIPTAP_HISTORY ? {} : false,
      heading: { levels: [...HEADING_LEVELS] },
      code: false,
      underline: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        protocols: ['http', 'https'],
        enableClickSelection: true
      }
    }),
    Code.extend({ inclusive: false }),
    MarkdownUnderline,
    Highlight.extend({ inclusive: false }).configure({ multicolor: true }),
    MarkdownSuperscript,
    MarkdownSubscript,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Typography,
    ImageFigure,
    MermaidFigure,
    InfographicFigure,
    FigureCaptionKeys,
    BlockId,
    DedupeBlockIds
  ]
}
