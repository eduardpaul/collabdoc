import type { AnyExtension, JSONContent } from '@tiptap/core'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { generateUniqueIds } from '@tiptap/extension-unique-id'
import { schemaExtensions } from './schema'
import { isMarkdownSingleFile, setMarkdownSingleFile } from './markdown-mode'

export { isMarkdownSingleFile, setMarkdownSingleFile } from './markdown-mode'

/**
 * Markdown codec: `@tiptap/markdown` (Tiptap 3).
 * Figure fences use ` ```mermaid caption="…" ` / ` ```infographic caption="…" `.
 * Images use `![alt](assets/<hash>.<ext> "caption")` or data URIs in single-file mode.
 */
function markdownExtensions(): AnyExtension[] {
  return [
    ...schemaExtensions(),
    Markdown.configure({
      markedOptions: { gfm: true },
      indentation: { style: 'space', size: 2 }
    })
  ]
}

let manager: MarkdownManager | null = null

function getManager(): MarkdownManager {
  if (!manager) {
    manager = new MarkdownManager({
      extensions: markdownExtensions(),
      markedOptions: { gfm: true },
      indentation: { style: 'space', size: 2 }
    })
  }
  return manager
}

export function markdownToDoc(markdown: string): JSONContent {
  const parsed = getManager().parse(markdown)
  return generateUniqueIds(parsed, markdownExtensions())
}

export function docToMarkdown(doc: JSONContent, options?: { singleFile?: boolean }): string {
  const previous = isMarkdownSingleFile()
  setMarkdownSingleFile(options?.singleFile ?? false)
  try {
    return getManager()
      .serialize(doc)
      .replace(/\u00a0/g, ' ')
      .trim()
  } finally {
    setMarkdownSingleFile(previous)
  }
}

export function selectionToMarkdown(content: JSONContent[]): string {
  return docToMarkdown({ type: 'doc', content })
}
