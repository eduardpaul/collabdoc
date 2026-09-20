import { z } from 'zod'

export const PAGE_SIZES = ['A4', 'Letter', 'Legal'] as const
export const PAGE_ORIENTATIONS = ['portrait', 'landscape'] as const
export const TOC_DEPTHS = [1, 2, 3, 4] as const
export const FIGURE_SCALES = [1, 2, 3, 4] as const
export const BODY_FONTS = ['Calibri', 'Arial', 'Georgia', 'Times New Roman', 'Aptos'] as const
export const MONO_FONTS = ['Consolas', 'Courier New'] as const
export const MERMAID_THEMES = ['neutral', 'default', 'dark', 'forest'] as const
export const INFOGRAPHIC_THEMES = ['light', 'dark', 'hand-drawn'] as const
export const FIGURE_BACKGROUNDS = ['white', 'transparent'] as const
export const CAPTION_ALIGNS = ['center', 'left'] as const

export type PageSize = (typeof PAGE_SIZES)[number]
export type PageOrientation = (typeof PAGE_ORIENTATIONS)[number]
export type BodyFont = (typeof BODY_FONTS)[number]
export type MonoFont = (typeof MONO_FONTS)[number]
export type MermaidTheme = (typeof MERMAID_THEMES)[number]
export type InfographicTheme = (typeof INFOGRAPHIC_THEMES)[number]
export type FigureBackground = (typeof FIGURE_BACKGROUNDS)[number]
export type CaptionAlign = (typeof CAPTION_ALIGNS)[number]
export type TocDepth = (typeof TOC_DEPTHS)[number]
export type FigureScale = (typeof FIGURE_SCALES)[number]

export type DocxExportConfig = {
  version: 1
  lang: string
  page: {
    size: PageSize
    orientation: PageOrientation
    marginsMm: { top: number; right: number; bottom: number; left: number }
  }
  titleBlock: { enabled: boolean; author: boolean; date: boolean }
  toc: { enabled: boolean; depth: TocDepth; title: string }
  headings: { chapterPageBreaks: boolean }
  footer: { pageNumbers: boolean }
  typography: {
    body: BodyFont
    heading: BodyFont
    mono: MonoFont
    baseSizePt: number
  }
  figures: {
    scale: FigureScale
    maxWidthPx: number
    upscale: boolean
    captionAlign: CaptionAlign
    numberCaptions: boolean
    mermaidTheme: MermaidTheme
    infographicTheme: InfographicTheme
    background: FigureBackground
  }
}

export const DEFAULT_DOCX_CONFIG: DocxExportConfig = {
  version: 1,
  lang: 'en-US',
  page: {
    size: 'A4',
    orientation: 'portrait',
    marginsMm: { top: 20, right: 18, bottom: 20, left: 18 }
  },
  titleBlock: { enabled: true, author: true, date: true },
  toc: { enabled: true, depth: 3, title: 'Contents' },
  headings: { chapterPageBreaks: false },
  footer: { pageNumbers: true },
  typography: {
    body: 'Calibri',
    heading: 'Calibri',
    mono: 'Consolas',
    baseSizePt: 11
  },
  figures: {
    scale: 4,
    maxWidthPx: 3000,
    upscale: false,
    captionAlign: 'center',
    numberCaptions: false,
    mermaidTheme: 'neutral',
    infographicTheme: 'light',
    background: 'white'
  }
}

const MARGIN_MIN = 5
const MARGIN_MAX = 50
const MIN_WRITABLE_MM = 60

const PAGE_WIDTH_MM: Record<PageSize, { portrait: number; landscape: number }> = {
  A4: { portrait: 210, landscape: 297 },
  Letter: { portrait: 215.9, landscape: 279.4 },
  Legal: { portrait: 215.9, landscape: 355.6 }
}

const pageSizeSchema = z.enum(PAGE_SIZES)
const orientationSchema = z.enum(PAGE_ORIENTATIONS)
const tocDepthSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
const scaleSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
const bodyFontSchema = z.enum(BODY_FONTS)
const monoFontSchema = z.enum(MONO_FONTS)
const mermaidThemeSchema = z.enum(MERMAID_THEMES)
const infographicThemeSchema = z.enum(INFOGRAPHIC_THEMES)
const backgroundSchema = z.enum(FIGURE_BACKGROUNDS)
const captionAlignSchema = z.enum(CAPTION_ALIGNS)
const boolSchema = z.boolean()
const langSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)

function pick<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function clampMargin(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, Math.round(n)))
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

function clampMargins(
  size: PageSize,
  orientation: PageOrientation,
  margins: DocxExportConfig['page']['marginsMm']
): DocxExportConfig['page']['marginsMm'] {
  const widthMm = PAGE_WIDTH_MM[size][orientation]
  const { top, bottom } = margins
  let { right, left } = margins
  while (widthMm - left - right < MIN_WRITABLE_MM) {
    if (left <= MARGIN_MIN && right <= MARGIN_MIN) break
    if (left >= right && left > MARGIN_MIN) left -= 1
    else if (right > MARGIN_MIN) right -= 1
    else if (left > MARGIN_MIN) left -= 1
    else break
  }
  return { top, right, bottom, left }
}

/**
 * Drop unknown keys and replace invalid values field-by-field so a hostile
 * blob never reaches the OpenXML. Always returns a complete config.
 */
export function normalizeDocxConfig(raw: unknown): DocxExportConfig {
  const rec = asRecord(raw) ?? {}
  const pageRec = asRecord(rec.page) ?? {}
  const marginRec = asRecord(pageRec.marginsMm) ?? {}
  const titleRec = asRecord(rec.titleBlock) ?? {}
  const tocRec = asRecord(rec.toc) ?? {}
  const headingsRec = asRecord(rec.headings) ?? {}
  const footerRec = asRecord(rec.footer) ?? {}
  const typeRec = asRecord(rec.typography) ?? {}
  const figRec = asRecord(rec.figures) ?? {}
  const d = DEFAULT_DOCX_CONFIG

  const size = pick(pageSizeSchema, pageRec.size, d.page.size)
  const orientation = pick(orientationSchema, pageRec.orientation, d.page.orientation)
  const marginsMm = clampMargins(size, orientation, {
    top: clampMargin(marginRec.top, d.page.marginsMm.top),
    right: clampMargin(marginRec.right, d.page.marginsMm.right),
    bottom: clampMargin(marginRec.bottom, d.page.marginsMm.bottom),
    left: clampMargin(marginRec.left, d.page.marginsMm.left)
  })

  const tocTitle =
    typeof tocRec.title === 'string' && tocRec.title.trim() ? tocRec.title : d.toc.title

  return {
    version: 1,
    lang: pick(langSchema, rec.lang, d.lang),
    page: { size, orientation, marginsMm },
    titleBlock: {
      enabled: pick(boolSchema, titleRec.enabled, d.titleBlock.enabled),
      author: pick(boolSchema, titleRec.author, d.titleBlock.author),
      date: pick(boolSchema, titleRec.date, d.titleBlock.date)
    },
    toc: {
      enabled: pick(boolSchema, tocRec.enabled, d.toc.enabled),
      depth: pick(tocDepthSchema, tocRec.depth, d.toc.depth),
      title: tocTitle
    },
    headings: {
      chapterPageBreaks: pick(
        boolSchema,
        headingsRec.chapterPageBreaks,
        d.headings.chapterPageBreaks
      )
    },
    footer: {
      pageNumbers: pick(boolSchema, footerRec.pageNumbers, d.footer.pageNumbers)
    },
    typography: {
      body: pick(bodyFontSchema, typeRec.body, d.typography.body),
      heading: pick(bodyFontSchema, typeRec.heading, d.typography.heading),
      mono: pick(monoFontSchema, typeRec.mono, d.typography.mono),
      baseSizePt: Math.round(pickNumber(typeRec.baseSizePt, d.typography.baseSizePt, 8, 24))
    },
    figures: {
      scale: pick(scaleSchema, figRec.scale, d.figures.scale),
      maxWidthPx: Math.round(pickNumber(figRec.maxWidthPx, d.figures.maxWidthPx, 200, 8000)),
      upscale: pick(boolSchema, figRec.upscale, d.figures.upscale),
      captionAlign: pick(captionAlignSchema, figRec.captionAlign, d.figures.captionAlign),
      numberCaptions: pick(boolSchema, figRec.numberCaptions, d.figures.numberCaptions),
      mermaidTheme: pick(mermaidThemeSchema, figRec.mermaidTheme, d.figures.mermaidTheme),
      infographicTheme: pick(
        infographicThemeSchema,
        figRec.infographicTheme,
        d.figures.infographicTheme
      ),
      background: pick(backgroundSchema, figRec.background, d.figures.background)
    }
  }
}

export function summarizeDocxConfig(config: DocxExportConfig): string {
  const { page, toc, figures } = config
  const m = page.marginsMm
  const tocBit = toc.enabled ? `TOC to H${toc.depth}` : 'no TOC'
  return `${page.size} ${page.orientation} · ${m.top}/${m.right} mm · ${tocBit} · figures ${figures.scale}×`
}
