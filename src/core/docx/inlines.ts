import {
  ExternalHyperlink,
  HighlightColor,
  TextRun,
  UnderlineType,
  type ParagraphChild
} from 'docx'
import { LoroMap, LoroText } from 'loro-crdt'
import { getAttrs, getChildren, nodeName, textMarks } from '../tree'
import type { DocxExportWarning } from './types'

type MarkRun = {
  type: string
  attrs?: Record<string, unknown>
  start: number
  end: number
}

const HIGHLIGHT_RGB: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  darkBlue: [0, 0, 128],
  darkCyan: [0, 128, 128],
  darkGray: [128, 128, 128],
  darkGreen: [0, 128, 0],
  darkMagenta: [128, 0, 128],
  darkRed: [128, 0, 0],
  darkYellow: [128, 128, 0],
  green: [0, 255, 0],
  lightGray: [192, 192, 192],
  magenta: [255, 0, 255],
  red: [255, 0, 0],
  white: [255, 255, 255],
  yellow: [255, 255, 0]
}

function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16)
    ]
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16)
    ]
  }
  return null
}

export function nearestHighlight(
  color: unknown
): (typeof HighlightColor)[keyof typeof HighlightColor] {
  if (typeof color === 'string') {
    const named = color.replace(/-/g, '')
    const key = Object.keys(HIGHLIGHT_RGB).find((k) => k.toLowerCase() === named.toLowerCase())
    if (key) return HighlightColor[key as keyof typeof HighlightColor]
    const rgb = parseHex(color)
    if (rgb) {
      let best: keyof typeof HIGHLIGHT_RGB = 'yellow'
      let bestDist = Infinity
      for (const [name, sample] of Object.entries(HIGHLIGHT_RGB)) {
        const dist =
          (sample[0] - rgb[0]) ** 2 + (sample[1] - rgb[1]) ** 2 + (sample[2] - rgb[2]) ** 2
        if (dist < bestDist) {
          bestDist = dist
          best = name as keyof typeof HIGHLIGHT_RGB
        }
      }
      return HighlightColor[best as keyof typeof HighlightColor]
    }
  }
  return HighlightColor.YELLOW
}

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

function runFromMarks(
  text: string,
  marks: MarkRun[],
  warnings: DocxExportWarning[],
  blockId?: string
): ParagraphChild {
  const opts: {
    text: string
    bold?: boolean
    italics?: boolean
    underline?: { type: (typeof UnderlineType)[keyof typeof UnderlineType] }
    strike?: boolean
    style?: string
    superScript?: boolean
    subScript?: boolean
    highlight?: (typeof HighlightColor)[keyof typeof HighlightColor]
  } = { text }
  let href: string | null = null
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        opts.bold = true
        break
      case 'italic':
        opts.italics = true
        break
      case 'underline':
        opts.underline = { type: UnderlineType.SINGLE }
        break
      case 'strike':
        opts.strike = true
        break
      case 'code':
        opts.style = 'CodeChar'
        break
      case 'superscript':
        opts.superScript = true
        break
      case 'subscript':
        opts.subScript = true
        break
      case 'highlight':
        opts.highlight = nearestHighlight(mark.attrs?.color)
        break
      case 'link': {
        const raw = typeof mark.attrs?.href === 'string' ? mark.attrs.href : ''
        if (isHttpUrl(raw)) href = raw
        else if (raw) {
          warnings.push({
            code: 'LINK_UNSUPPORTED_SCHEME',
            blockId,
            message: `Link scheme is not exported: ${raw}`
          })
        }
        break
      }
      default:
        break
    }
  }
  if (!href) return new TextRun(opts)
  return new ExternalHyperlink({
    link: href,
    children: [new TextRun({ ...opts, style: 'Hyperlink' })]
  })
}

function markedRuns(
  text: string,
  marks: MarkRun[],
  warnings: DocxExportWarning[],
  blockId?: string
): ParagraphChild[] {
  if (!text) return []
  if (marks.length === 0) return [new TextRun(text)]
  const boundaries = new Set<number>([0, text.length])
  for (const mark of marks) {
    boundaries.add(Math.max(0, Math.min(text.length, mark.start)))
    boundaries.add(Math.max(0, Math.min(text.length, mark.end)))
  }
  const points = [...boundaries].sort((a, b) => a - b)
  const out: ParagraphChild[] = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]
    const end = points[i + 1]
    const slice = text.slice(start, end)
    if (!slice) continue
    const active = marks.filter((mark) => mark.start <= start && mark.end >= end)
    out.push(runFromMarks(slice, active, warnings, blockId))
  }
  return out
}

/** Inline children of a text-bearing block: marked text plus `@handle` mentions. */
export function inlineChildren(
  node: LoroMap,
  warnings: DocxExportWarning[],
  blockId?: string
): ParagraphChild[] {
  const children = getChildren(node)
  const out: ParagraphChild[] = []
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroText) {
      // Text is split into one LoroText per run around inline nodes; each carries its own marks.
      out.push(...markedRuns(child.toString(), textMarks(child), warnings, blockId))
      continue
    }
    if (child instanceof LoroMap && nodeName(child) === 'mention') {
      const attrs = getAttrs(child)
      const handle = attrs.get('handle') ?? attrs.get('label')
      if (typeof handle === 'string' && handle) out.push(new TextRun(`@${handle}`))
    }
  }
  return out
}
