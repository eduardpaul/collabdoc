import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  SequentialIdentifier,
  TableOfContents,
  TextRun,
  type FileChild,
  type IImageOptions,
  type ParagraphChild
} from 'docx'
import { LoroMap, LoroText } from 'loro-crdt'
import { base64ToBytes } from '../../shared/base64'
import { ASSET_SRC_PREFIX } from '../../shared/constants'
import type { DocxExportConfig } from '../../shared/docx-config'
import { readMeta } from '../document'
import {
  attrsJson,
  blockIdOf,
  captionOf,
  getChildren,
  getRoot,
  nodeName,
  syntaxSourceOf
} from '../tree'
import { pageGeometry, type PageGeometry } from './geometry'
import { imageSize, nativeImageType, type NativeImageType } from './image-size'
import { inlineChildren } from './inlines'
import { documentStyles, numberingConfig } from './styles'
import type {
  BuildDocxInput,
  BuildDocxResult,
  DocxAsset,
  DocxExportWarning,
  RenderedFigure
} from './types'

const HEADING = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4
] as const

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
}

type ListCtx = {
  kind: 'bullet' | 'ordered' | 'task'
  level: number
  instance?: number
  checked?: boolean
}

type WalkCtx = {
  config: DocxExportConfig
  geometry: PageGeometry
  figures: Map<string, RenderedFigure>
  assets: Map<string, DocxAsset>
  warnings: DocxExportWarning[]
  usedBookmarks: Set<string>
  orderedInstance: number
  seenH1: boolean
  lastHeadingLevel: number
}

function clampLevel(level: unknown): 1 | 2 | 3 | 4 {
  const n = typeof level === 'number' ? level : Number(level)
  if (n >= 1 && n <= 4) return Math.floor(n) as 1 | 2 | 3 | 4
  return 1
}

function bookmarkName(blockId: string, used: Set<string>): string {
  const base = `b_${blockId}`.replace(/\W/g, '_').slice(0, 40) || 'b_heading'
  let name = base
  let n = 2
  while (used.has(name)) {
    const suffix = `_${n}`
    name = `${base.slice(0, 40 - suffix.length)}${suffix}`
    n += 1
  }
  used.add(name)
  return name
}

function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function alignmentOf(
  value: unknown
): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  if (typeof value !== 'string') return undefined
  return ALIGN[value]
}

function hashFromSrc(src: string): string | null {
  if (!src.startsWith(ASSET_SRC_PREFIX)) return null
  return src.slice(ASSET_SRC_PREFIX.length)
}

function extraIndent(dxa: number): { left: number } | undefined {
  return dxa > 0 ? { left: dxa } : undefined
}

function codeRuns(text: string): ParagraphChild[] {
  const lines = text.split('\n')
  return lines.map((line, i) => new TextRun({ text: line, break: i > 0 ? 1 : 0 }))
}

function walkChildren(
  node: LoroMap,
  ctx: WalkCtx,
  indent: number,
  list: ListCtx | null
): FileChild[] {
  const children = getChildren(node)
  const out: FileChild[] = []
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroMap) out.push(...walkBlock(child, ctx, indent, list, i))
  }
  return out
}

function walkBlock(
  node: LoroMap,
  ctx: WalkCtx,
  indent: number,
  list: ListCtx | null,
  index: number
): FileChild[] {
  const type = nodeName(node)
  const attrs = attrsJson(node)
  const blockId = blockIdOf(node)
  const align = alignmentOf(attrs.textAlign)
  const indentOpts = extraIndent(indent)

  switch (type) {
    case 'heading': {
      const level = clampLevel(attrs.level)
      if (ctx.lastHeadingLevel > 0 && level > ctx.lastHeadingLevel + 1) {
        ctx.warnings.push({
          code: 'HEADING_LEVEL_SKIPPED',
          blockId,
          message: `Heading skipped from H${ctx.lastHeadingLevel} to H${level}`
        })
      }
      ctx.lastHeadingLevel = level
      const pageBreakBefore = level === 1 && ctx.config.headings.chapterPageBreaks && ctx.seenH1
      if (level === 1) ctx.seenH1 = true
      const name = bookmarkName(blockId ?? `h${index}`, ctx.usedBookmarks)
      return [
        new Paragraph({
          heading: HEADING[level - 1],
          keepNext: true,
          pageBreakBefore,
          indent: indentOpts,
          children: [
            new Bookmark({
              id: name,
              children: inlineChildren(node, ctx.warnings, blockId)
            })
          ]
        })
      ]
    }
    case 'paragraph': {
      const numbering =
        list && list.kind !== 'task'
          ? {
              reference: list.kind === 'bullet' ? 'bullets' : 'numbers',
              level: list.level,
              instance: list.kind === 'ordered' ? list.instance : undefined
            }
          : undefined
      const prefix = list?.kind === 'task' ? (list.checked === true ? '☑ ' : '☐ ') : ''
      const children: ParagraphChild[] = [
        ...(prefix ? [new TextRun(prefix)] : []),
        ...inlineChildren(node, ctx.warnings, blockId)
      ]
      return [
        new Paragraph({
          alignment: align,
          numbering,
          indent:
            list?.kind === 'task' ? { left: 720 * (list.level + 1), hanging: 360 } : indentOpts,
          children: children.length ? children : [new TextRun('')]
        })
      ]
    }
    case 'blockquote':
      return walkQuote(node, ctx, indent)
    case 'codeBlock': {
      const text = codeText(node)
      return [
        new Paragraph({
          style: 'Code',
          indent: indentOpts,
          keepLines: true,
          children: codeRuns(text)
        })
      ]
    }
    case 'horizontalRule':
      return [
        new Paragraph({
          indent: indentOpts,
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 }
          }
        })
      ]
    case 'bulletList':
      return walkChildren(node, ctx, indent, { kind: 'bullet', level: list ? list.level + 1 : 0 })
    case 'orderedList': {
      ctx.orderedInstance += 1
      return walkChildren(node, ctx, indent, {
        kind: 'ordered',
        level: list ? list.level + 1 : 0,
        instance: ctx.orderedInstance
      })
    }
    case 'taskList':
      return walkChildren(node, ctx, indent, { kind: 'task', level: list ? list.level + 1 : 0 })
    case 'listItem':
    case 'taskItem':
      return walkListItem(node, ctx, indent, list)
    case 'mermaidFigure':
    case 'infographicFigure':
    case 'imageFigure':
      return walkFigure(node, ctx, indent)
    default:
      return [
        new Paragraph({
          indent: indentOpts,
          children: inlineChildren(node, ctx.warnings, blockId)
        })
      ]
  }
}

function walkQuote(node: LoroMap, ctx: WalkCtx, indent: number): FileChild[] {
  const extra = indent + mmToDxaQuote()
  const children = getChildren(node)
  const out: FileChild[] = []
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (!(child instanceof LoroMap)) continue
    const type = nodeName(child)
    if (type === 'paragraph') {
      out.push(
        new Paragraph({
          style: 'Quote',
          indent: extraIndent(extra),
          children: inlineChildren(child, ctx.warnings, blockIdOf(child))
        })
      )
    } else {
      out.push(...walkBlock(child, ctx, extra, null, i))
    }
  }
  return out
}

function mmToDxaQuote(): number {
  return Math.round((5 * 1440) / 25.4)
}

function walkListItem(
  node: LoroMap,
  ctx: WalkCtx,
  indent: number,
  list: ListCtx | null
): FileChild[] {
  const itemList: ListCtx | null =
    list?.kind === 'task' ? { ...list, checked: attrsJson(node).checked === true } : list
  const children = getChildren(node)
  const out: FileChild[] = []
  let first = true
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (!(child instanceof LoroMap)) continue
    const type = nodeName(child)
    if (type === 'bulletList' || type === 'orderedList' || type === 'taskList') {
      out.push(...walkBlock(child, ctx, indent, itemList, i))
      first = false
      continue
    }
    if (type === 'paragraph' && first && itemList) {
      out.push(...walkBlock(child, ctx, indent, itemList, i))
      first = false
      continue
    }
    out.push(...walkBlock(child, ctx, indent + 720, null, i))
    first = false
  }
  if (out.length === 0 && itemList) {
    out.push(
      new Paragraph({
        numbering:
          itemList.kind === 'task'
            ? undefined
            : {
                reference: itemList.kind === 'bullet' ? 'bullets' : 'numbers',
                level: itemList.level,
                instance: itemList.kind === 'ordered' ? itemList.instance : undefined
              },
        indent:
          itemList.kind === 'task' ? { left: 720 * (itemList.level + 1), hanging: 360 } : undefined,
        children: [new TextRun(itemList.kind === 'task' ? (itemList.checked ? '☑ ' : '☐ ') : '')]
      })
    )
  }
  return out
}

function codeText(node: LoroMap): string {
  const children = getChildren(node)
  let out = ''
  for (let i = 0; i < children.length; i += 1) {
    const child = children.get(i)
    if (child instanceof LoroText) out += child.toString()
  }
  return out
}

function walkFigure(node: LoroMap, ctx: WalkCtx, indent: number): FileChild[] {
  const type = nodeName(node)
  const attrs = attrsJson(node)
  const blockId = blockIdOf(node) ?? ''
  const caption = captionOf(node)
  const align = alignmentOf(attrs.align) ?? AlignmentType.CENTER
  const widthPct = (typeof attrs.width === 'number' ? attrs.width : 100) / 100
  const rendered = ctx.figures.get(blockId)

  if (type === 'mermaidFigure' || type === 'infographicFigure') {
    if (rendered?.error || !rendered?.pngBase64) {
      ctx.warnings.push({
        code: 'FIGURE_RENDER_FAILED',
        blockId,
        message: rendered?.error || 'Figure failed to render'
      })
      return failedFigure(syntaxSourceOf(node), caption, indent)
    }
    return embedPng(ctx, {
      blockId,
      png: rendered.pngBase64,
      widthPx: rendered.widthPx ?? 1,
      heightPx: rendered.heightPx ?? 1,
      cssWidthPx: rendered.cssWidthPx,
      alt: rendered.alt,
      caption,
      captionRuns: inlineChildren(node, ctx.warnings, blockId),
      align,
      widthPct,
      indent
    })
  }

  const src = typeof attrs.src === 'string' ? attrs.src : ''
  const hash = hashFromSrc(src)
  const asset = hash ? ctx.assets.get(hash) : undefined
  if (!asset) {
    ctx.warnings.push({
      code: 'ASSET_MISSING',
      blockId,
      message: `Missing image${caption ? `: ${caption}` : ''}`
    })
    return [
      new Paragraph({
        indent: extraIndent(indent),
        children: [new TextRun(`[missing image: ${caption || 'image'}]`)]
      })
    ]
  }

  const nativeType = nativeImageType(asset.mime)
  if (!nativeType) {
    if (rendered?.error || !rendered?.pngBase64) {
      ctx.warnings.push({
        code: 'FIGURE_RENDER_FAILED',
        blockId,
        message: rendered?.error || `Image could not be converted (${asset.mime})`
      })
      return failedFigure('', caption, indent)
    }
    const alt =
      rendered.alt || (typeof attrs.alt === 'string' && attrs.alt ? attrs.alt : caption || 'Image')
    return embedPng(ctx, {
      blockId,
      png: rendered.pngBase64,
      widthPx: rendered.widthPx ?? 1,
      heightPx: rendered.heightPx ?? 1,
      cssWidthPx: rendered.cssWidthPx,
      alt,
      caption,
      captionRuns: inlineChildren(node, ctx.warnings, blockId),
      align,
      widthPct,
      indent
    })
  }

  const alt = typeof attrs.alt === 'string' && attrs.alt ? attrs.alt : caption || 'Image'
  const natural = imageSize(asset.bytes, nativeType)
  return embedImage(ctx, {
    blockId,
    data: asset.bytes,
    type: nativeType,
    naturalWidthPx: natural?.width,
    naturalHeightPx: natural?.height,
    alt,
    caption,
    captionRuns: inlineChildren(node, ctx.warnings, blockId),
    align,
    widthPct,
    indent
  })
}

function failedFigure(source: string, caption: string, indent: number): FileChild[] {
  const out: FileChild[] = [
    new Paragraph({
      style: 'Code',
      indent: extraIndent(indent),
      keepLines: true,
      children: codeRuns(source)
    })
  ]
  if (caption) {
    out.push(
      new Paragraph({
        style: 'Caption',
        indent: extraIndent(indent),
        children: [new TextRun(caption)]
      })
    )
  }
  return out
}

function embedPng(
  ctx: WalkCtx,
  input: {
    blockId: string
    png: string
    widthPx: number
    heightPx: number
    cssWidthPx?: number
    alt: string
    caption: string
    captionRuns: ParagraphChild[]
    align: (typeof AlignmentType)[keyof typeof AlignmentType]
    widthPct: number
    indent: number
  }
): FileChild[] {
  const bytes = base64ToBytes(input.png)
  const cssWidth = input.cssWidthPx ?? input.widthPx
  const cssHeight = input.widthPx > 0 ? (input.heightPx / input.widthPx) * cssWidth : input.heightPx
  return embedImage(ctx, {
    blockId: input.blockId,
    data: bytes,
    type: 'png',
    naturalWidthPx: cssWidth,
    naturalHeightPx: cssHeight,
    alt: input.alt,
    caption: input.caption,
    captionRuns: input.captionRuns,
    align: input.align,
    widthPct: input.widthPct,
    indent: input.indent
  })
}

function embedImage(
  ctx: WalkCtx,
  input: {
    blockId: string
    data: Uint8Array
    type: NativeImageType
    naturalWidthPx?: number
    naturalHeightPx?: number
    alt: string
    caption: string
    captionRuns: ParagraphChild[]
    align: (typeof AlignmentType)[keyof typeof AlignmentType]
    widthPct: number
    indent: number
  }
): FileChild[] {
  const { geometry, config } = ctx
  let displayWidthPx = geometry.writableWidthPx * input.widthPct
  const natural = input.naturalWidthPx
  if (!config.figures.upscale && natural && natural < displayWidthPx) {
    displayWidthPx = natural
  }
  let displayHeightPx =
    input.naturalWidthPx && input.naturalHeightPx
      ? displayWidthPx * (input.naturalHeightPx / input.naturalWidthPx)
      : displayWidthPx * 0.6
  if (displayHeightPx > geometry.writableHeightPx && displayHeightPx > 0) {
    const factor = geometry.writableHeightPx / displayHeightPx
    displayWidthPx *= factor
    displayHeightPx = geometry.writableHeightPx
    ctx.warnings.push({
      code: 'FIGURE_DOWNSCALED',
      blockId: input.blockId,
      message: 'Figure was taller than the writable page height and was downscaled'
    })
  }
  const width = Math.max(1, Math.round(displayWidthPx))
  const height = Math.max(1, Math.round(displayHeightPx))
  const image: IImageOptions = {
    type: input.type,
    data: input.data,
    transformation: { width, height },
    altText: {
      name: input.blockId || 'figure',
      title: input.caption || input.alt,
      description: input.alt
    }
  }
  const out: FileChild[] = [
    new Paragraph({
      alignment: input.align,
      indent: extraIndent(input.indent),
      children: [new ImageRun(image)]
    })
  ]
  if (input.caption) {
    const captionChildren: ParagraphChild[] = []
    if (config.figures.numberCaptions) {
      captionChildren.push(
        new TextRun('Figure '),
        new SequentialIdentifier('Figure'),
        new TextRun(': ')
      )
    }
    captionChildren.push(
      ...(input.captionRuns.length ? input.captionRuns : [new TextRun(input.caption)])
    )
    out.push(
      new Paragraph({
        style: 'Caption',
        alignment: ALIGN[config.figures.captionAlign] ?? AlignmentType.CENTER,
        indent: extraIndent(input.indent),
        children: captionChildren
      })
    )
  }
  return out
}

function titleBlock(
  config: DocxExportConfig,
  title: string,
  author: string,
  createdAt: number
): FileChild[] {
  if (!config.titleBlock.enabled) return []
  const out: FileChild[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(title || 'Untitled')]
    })
  ]
  const parts: string[] = []
  if (config.titleBlock.author && author) parts.push(author)
  if (config.titleBlock.date) {
    const date = formatDate(createdAt)
    if (date) parts.push(date)
  }
  if (parts.length) {
    out.push(
      new Paragraph({
        style: 'Subtitle',
        children: [new TextRun(parts.join(' · '))]
      })
    )
  }
  return out
}

async function packDocument(doc: Document): Promise<Uint8Array> {
  const blob = await Packer.toBlob(doc)
  return new Uint8Array(await blob.arrayBuffer())
}

export async function buildDocx(input: BuildDocxInput): Promise<BuildDocxResult> {
  const config = input.config
  const geometry = pageGeometry(config)
  const warnings: DocxExportWarning[] = []
  const figures = new Map<string, RenderedFigure>()
  for (const figure of input.figures ?? []) figures.set(figure.blockId, figure)
  const assets = new Map<string, DocxAsset>()
  for (const asset of input.assets ?? []) assets.set(asset.hash, asset)

  const ctx: WalkCtx = {
    config,
    geometry,
    figures,
    assets,
    warnings,
    usedBookmarks: new Set(),
    orderedInstance: 0,
    seenH1: false,
    lastHeadingLevel: 0
  }

  const meta = readMeta(input.doc)
  const author = input.author ?? ''
  const children: FileChild[] = []
  children.push(...titleBlock(config, meta.title, author, meta.createdAt))
  if (config.toc.enabled) {
    children.push(
      new TableOfContents(config.toc.title, {
        hyperlink: true,
        headingStyleRange: `1-${config.toc.depth}`
      })
    )
  }
  if (config.titleBlock.enabled || config.toc.enabled) {
    children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  children.push(...walkChildren(getRoot(input.doc), ctx, 0, null))

  const footer = config.footer.pageNumbers
    ? {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun('Page '),
                new TextRun({ children: [PageNumber.CURRENT] }),
                new TextRun(' of '),
                new TextRun({ children: [PageNumber.TOTAL_PAGES] })
              ]
            })
          ]
        })
      }
    : undefined

  const document = new Document({
    title: meta.title,
    creator: author,
    lastModifiedBy: author,
    styles: documentStyles(config),
    numbering: numberingConfig(),
    features: config.toc.enabled ? { updateFields: true } : undefined,
    sections: [
      {
        properties: {
          page: {
            size: {
              width: geometry.widthDxa,
              height: geometry.heightDxa,
              orientation: geometry.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
            },
            margin: {
              top: geometry.marginDxa.top,
              right: geometry.marginDxa.right,
              bottom: geometry.marginDxa.bottom,
              left: geometry.marginDxa.left
            }
          }
        },
        footers: footer,
        children
      }
    ]
  })

  const bytes = await packDocument(document)
  return { bytes, warnings }
}
