import { LoroDoc, LoroMap, LoroText } from 'loro-crdt'
import { readMeta } from './document'
import {
  attrsJson,
  blockMarks,
  captionOf,
  getChildren,
  getRoot,
  isSyntaxFigure,
  nodeName,
  syntaxSourceOf
} from './tree'

/**
 * A Markdown rendering of the document straight from the Loro tree, for
 * readers that are not the editor (the MCP resource in 16, logs). The
 * renderer's export (04) goes through Tiptap and is the reference; this one
 * covers the same block and mark types but is not byte-identical to it.
 */
export function documentToMarkdown(doc: LoroDoc): string {
  const title = readMeta(doc).title
  const body = renderChildren(getRoot(doc), '', null)
  const heading = title ? `# ${title}\n\n` : ''
  return (heading + body).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderChildren(
  node: LoroMap,
  indent: string,
  listKind: 'bullet' | 'ordered' | 'task' | null
): string {
  const children = getChildren(node)
  const out: string[] = []
  let index = 1
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (!(child instanceof LoroMap)) continue
    out.push(renderBlock(child, indent, listKind, index))
    index += 1
  }
  return out.join('')
}

function renderBlock(
  node: LoroMap,
  indent: string,
  listKind: 'bullet' | 'ordered' | 'task' | null,
  index: number
): string {
  const type = nodeName(node)
  const attrs = attrsJson(node)
  switch (type) {
    case 'heading': {
      const level = clampLevel(attrs.level)
      return `${indent}${'#'.repeat(level)} ${inline(node)}\n\n`
    }
    case 'paragraph':
      return `${indent}${inline(node)}\n\n`
    case 'blockquote':
      return renderChildren(node, `${indent}> `, null).replace(/\n\n$/, '\n') + '\n'
    case 'codeBlock': {
      const lang = typeof attrs.language === 'string' ? attrs.language : ''
      return `${indent}\`\`\`${lang}\n${plain(node)}\n${indent}\`\`\`\n\n`
    }
    case 'horizontalRule':
      return `${indent}---\n\n`
    case 'bulletList':
      return renderChildren(node, indent, 'bullet')
    case 'orderedList':
      return renderChildren(node, indent, 'ordered')
    case 'taskList':
      return renderChildren(node, indent, 'task')
    case 'listItem':
    case 'taskItem': {
      const marker =
        listKind === 'ordered'
          ? `${index}. `
          : listKind === 'task'
            ? `- [${attrs.checked === true ? 'x' : ' '}] `
            : '- '
      const inner = renderChildren(node, `${indent}${' '.repeat(marker.length)}`, null)
      // The first line of the item carries the marker; the rest keeps the indent.
      const firstLine = inner.replace(/^\s*/, '')
      return `${indent}${marker}${firstLine.replace(/\n\n$/, '\n')}`
    }
    case 'mermaidFigure':
    case 'infographicFigure': {
      const fence = type === 'mermaidFigure' ? 'mermaid' : 'infographic'
      const caption = captionOf(node)
      const captionLine = caption ? `${indent}*${caption}*\n` : ''
      return `${indent}\`\`\`${fence}\n${syntaxSourceOf(node)}\n${indent}\`\`\`\n${captionLine}\n`
    }
    case 'imageFigure': {
      const src = typeof attrs.src === 'string' ? attrs.src : ''
      return `${indent}![${captionOf(node)}](${src})\n\n`
    }
    default:
      return isSyntaxFigure(node)
        ? `${indent}${syntaxSourceOf(node)}\n\n`
        : `${indent}${inline(node)}\n\n`
  }
}

function clampLevel(level: unknown): number {
  const n = typeof level === 'number' ? level : Number(level)
  return Number.isFinite(n) && n >= 1 && n <= 6 ? Math.floor(n) : 1
}

function plain(node: LoroMap): string {
  const children = getChildren(node)
  let out = ''
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroText) out += child.toString()
  }
  return out
}

/** Text with marks re-applied as Markdown; mention nodes become `@handle`. */
function inline(node: LoroMap): string {
  const children = getChildren(node)
  let out = ''
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroText) {
      out += markedText(node, child.toString())
      continue
    }
    if (child instanceof LoroMap && nodeName(child) === 'mention') {
      const attrs = attrsJson(child)
      const handle = attrs.handle ?? attrs.label
      if (typeof handle === 'string' && handle) out += `@${handle}`
    }
  }
  return out
}

function markedText(node: LoroMap, text: string): string {
  const marks = blockMarks(node)
  if (marks.length === 0) return text
  // Marks are non-overlapping per type in Loro's delta; wrap each run once.
  const boundaries = new Set<number>([0, text.length])
  for (const mark of marks) {
    boundaries.add(mark.start)
    boundaries.add(mark.end)
  }
  const points = [...boundaries].sort((a, b) => a - b)
  let out = ''
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]
    const end = points[i + 1]
    let run = text.slice(start, end)
    if (!run) continue
    for (const mark of marks) {
      if (mark.start > start || mark.end < end) continue
      run = wrap(mark.type, mark.attrs, run)
    }
    out += run
  }
  return out
}

function wrap(type: string, attrs: Record<string, unknown> | undefined, run: string): string {
  switch (type) {
    case 'bold':
      return `**${run}**`
    case 'italic':
      return `*${run}*`
    case 'strike':
      return `~~${run}~~`
    case 'code':
      return `\`${run}\``
    case 'highlight':
      return `==${run}==`
    case 'underline':
      return `<u>${run}</u>`
    case 'superscript':
      return `^${run}^`
    case 'subscript':
      return `~${run}~`
    case 'link': {
      const href = typeof attrs?.href === 'string' ? attrs.href : ''
      return href ? `[${run}](${href})` : run
    }
    default:
      return run
  }
}
