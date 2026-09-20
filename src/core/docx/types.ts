export const DOCX_WARNING_CODES = [
  'FIGURE_RENDER_FAILED',
  'ASSET_MISSING',
  'FIGURE_DOWNSCALED',
  'LINK_UNSUPPORTED_SCHEME',
  'HEADING_LEVEL_SKIPPED'
] as const

export type DocxWarningCode = (typeof DOCX_WARNING_CODES)[number]

export type DocxExportWarning = {
  code: DocxWarningCode
  blockId?: string
  message: string
}

export type RenderedFigure = {
  blockId: string
  kind?: DocxFigureReport['kind']
  key: string
  pngBase64?: string
  widthPx?: number
  heightPx?: number
  /** CSS-pixel width of the SVG before raster scale; used to avoid upscaling. */
  cssWidthPx?: number
  alt: string
  error?: string
  reused?: boolean
}

export type DocxAsset = {
  hash: string
  mime: string
  bytes: Uint8Array
}

export type DocxFigureReport = {
  blockId: string
  kind: 'mermaidFigure' | 'infographicFigure' | 'imageFigure'
  reused: boolean
  widthPx: number
  heightPx: number
}

export type DocxExportReport = {
  durationMs: number
  figures: DocxFigureReport[]
  warnings: DocxExportWarning[]
}

export type BuildDocxInput = {
  doc: import('loro-crdt').LoroDoc
  config: import('../../shared/docx-config').DocxExportConfig
  figures?: readonly RenderedFigure[]
  assets?: readonly DocxAsset[]
  author?: string
}

export type BuildDocxResult = {
  bytes: Uint8Array
  warnings: DocxExportWarning[]
}
