import type { JSONContent } from '@tiptap/core'
import { coerceDocJson, emptyDoc, textFromDoc } from '../editor/document'
import { docToMarkdown, markdownToDoc } from '../editor/markdown'

export function parseDocument(
  raw: string,
  fallbackTitle: string
): { title: string; content: JSONContent } {
  const match = raw.match(/^#\s+(.+)\r?\n?/)
  if (!match) {
    return { title: fallbackTitle, content: markdownToDoc(raw) }
  }
  return {
    title: match[1].trim() || fallbackTitle,
    content: markdownToDoc(raw.slice(match[0].length).replace(/^\r?\n/, ''))
  }
}

export function serializeDocument(
  title: string,
  content: JSONContent,
  options?: { singleFile?: boolean }
): string {
  const body = docToMarkdown(content, { singleFile: options?.singleFile })
  const first = body.split(/\r?\n/, 1)[0] ?? ''
  if (/^#\s+/.test(first)) {
    return body.endsWith('\n') ? body : `${body}\n`
  }
  return `# ${title.trim() || 'Untitled'}\n\n${body}`.trim() + '\n'
}

export function previewOf(content: JSONContent | string): string {
  const text = typeof content === 'string' ? content : textFromDoc(content)
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function titleFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  return base.replace(/\.(md|markdown|txt|collabdoc)$/i, '') || 'Untitled'
}

export { coerceDocJson, emptyDoc, markdownToDoc, docToMarkdown }
