import type { DocxExportConfig, PageSize } from '../../shared/docx-config'

/** 1440 twips (dxa) per inch; 25.4 mm per inch. Matches the POC `mmToDxa`. */
export function mmToDxa(mm: number): number {
  return Math.round((mm * 1440) / 25.4)
}

/** CSS pixels at 96 dpi. */
export function mmToPx(mm: number): number {
  return (mm * 96) / 25.4
}

const PAGE_DXA: Record<PageSize, { width: number; height: number }> = {
  A4: { width: mmToDxa(210), height: mmToDxa(297) },
  Letter: { width: 12240, height: 15840 },
  Legal: { width: 12240, height: 20160 }
}

const PAGE_MM: Record<PageSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 }
}

export type PageGeometry = {
  widthDxa: number
  heightDxa: number
  marginDxa: { top: number; right: number; bottom: number; left: number }
  writableWidthMm: number
  writableHeightMm: number
  writableWidthPx: number
  writableHeightPx: number
  landscape: boolean
}

export function pageGeometry(config: DocxExportConfig): PageGeometry {
  const portrait = PAGE_DXA[config.page.size]
  const portraitMm = PAGE_MM[config.page.size]
  const landscape = config.page.orientation === 'landscape'
  const widthMm = landscape ? portraitMm.height : portraitMm.width
  const heightMm = landscape ? portraitMm.width : portraitMm.height
  const margin = config.page.marginsMm
  const marginDxa = {
    top: mmToDxa(margin.top),
    right: mmToDxa(margin.right),
    bottom: mmToDxa(margin.bottom),
    left: mmToDxa(margin.left)
  }
  const writableWidthMm = widthMm - margin.left - margin.right
  const writableHeightMm = heightMm - margin.top - margin.bottom
  return {
    widthDxa: portrait.width,
    heightDxa: portrait.height,
    marginDxa,
    writableWidthMm,
    writableHeightMm,
    writableWidthPx: mmToPx(writableWidthMm),
    writableHeightPx: mmToPx(writableHeightMm),
    landscape
  }
}
