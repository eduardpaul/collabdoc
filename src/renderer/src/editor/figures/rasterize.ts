import type { JSONContent } from '@tiptap/core'
import type { DocxExportConfig } from '@shared/docx-config'
import {
  applyMermaidTheme,
  infographicAlt,
  infographicHasThemeLine,
  mermaidAlt
} from '@core/docx/alt'
import { pageGeometry } from '@core/docx/geometry'
import { nativeImageType } from '@core/docx/image-size'
import type { RenderedFigure } from '@core/docx/types'
import { base64ToBytes, bytesToBase64, getAsset, hashFromSrc, sha256Hex } from '../assets'
import { blobToPng, svgToPng } from './export'

export type RasterizeProgress = (current: number, total: number) => void

type RasterizeDeps = {
  renderMermaid?: (source: string) => Promise<string>
  renderInfographic?: (
    source: string,
    el: HTMLElement,
    signal: AbortSignal,
    options?: { theme?: string; widthPx?: number }
  ) => Promise<string>
  svgToPng?: typeof svgToPng
  getAsset?: typeof getAsset
}

type FigureTarget = {
  blockId: string
  kind: 'mermaidFigure' | 'infographicFigure' | 'imageFigure'
  source: string
  caption: string
  altHint: string
  widthPct: number
  /** An SVG image asset, rasterised like a diagram. */
  svgText?: string
  /** A bitmap Word cannot embed as-is (WebP, …), re-encoded as PNG. */
  bitmap?: Blob
}

const cache = new Map<string, RenderedFigure>()
let testDeps: RasterizeDeps = {}

export function setRasterizeDepsForTests(deps: RasterizeDeps | null): void {
  testDeps = deps ?? {}
}

export function resetFigurePngCache(): void {
  cache.clear()
}

function captionFrom(node: JSONContent): string {
  return (node.content ?? []).map((child) => child.text ?? '').join('')
}

function walkFigures(node: JSONContent, out: FigureTarget[]): void {
  const type = node.type
  const attrs = node.attrs ?? {}
  const blockId = typeof attrs.blockId === 'string' ? attrs.blockId : ''
  const widthPct = typeof attrs.width === 'number' ? attrs.width : 100
  if (type === 'mermaidFigure' || type === 'infographicFigure') {
    const source = String(attrs.source ?? '')
    const caption = captionFrom(node)
    out.push({
      blockId,
      kind: type,
      source,
      caption,
      altHint: caption,
      widthPct
    })
  } else if (type === 'imageFigure') {
    const src = typeof attrs.src === 'string' ? attrs.src : ''
    const hash = hashFromSrc(src)
    const asset = (testDeps.getAsset ?? getAsset)(hash ?? '')
    if (asset && !nativeImageType(asset.mime)) {
      const caption = captionFrom(node)
      const alt = typeof attrs.alt === 'string' ? attrs.alt : ''
      const bytes = base64ToBytes(asset.data)
      const isSvg = asset.mime.includes('svg') || asset.ext === 'svg'
      const svgText = isSvg ? new TextDecoder().decode(bytes) : undefined
      out.push({
        blockId,
        kind: 'imageFigure',
        source: svgText ?? asset.sha256,
        caption,
        altHint: alt || caption,
        widthPct,
        svgText,
        bitmap: isSvg ? undefined : new Blob([bytes.buffer as ArrayBuffer], { type: asset.mime })
      })
    }
  }
  for (const child of node.content ?? []) walkFigures(child, out)
}

/**
 * Spec key (kind, source, theme, scale, background, widthPct) plus the inputs
 * that change the pixels without changing the figure: the host width in CSS px
 * (page size, orientation, margins), the pixel cap and the upscale rule.
 */
async function cacheKey(
  target: FigureTarget,
  theme: string,
  config: DocxExportConfig,
  hostWidth: number
): Promise<string> {
  const material = [
    target.kind,
    target.source,
    theme,
    String(config.figures.scale),
    config.figures.background,
    String(target.widthPct),
    String(Math.round(hostWidth)),
    String(config.figures.maxWidthPx),
    config.figures.upscale ? 'upscale' : 'natural'
  ].join('\0')
  return sha256Hex(new TextEncoder().encode(material))
}

function altFor(target: FigureTarget): string {
  if (target.kind === 'mermaidFigure') {
    return mermaidAlt(target.source, target.caption || 'Mermaid diagram')
  }
  if (target.kind === 'infographicFigure') {
    return infographicAlt(target.source, target.caption || 'Infographic')
  }
  return target.altHint || target.caption || 'Image'
}

async function mermaidSvg(source: string): Promise<string> {
  if (testDeps.renderMermaid) return testDeps.renderMermaid(source)
  const { renderMermaidSvg } = await import('./mermaid-runtime')
  return renderMermaidSvg(source)
}

async function infographicSvg(
  source: string,
  widthPx: number,
  theme: string | undefined,
  signal: AbortSignal
): Promise<string> {
  if (testDeps.renderInfographic) {
    const host = document.createElement('div')
    return testDeps.renderInfographic(source, host, signal, { theme, widthPx })
  }
  const { infographicSvgFrom, renderInfographic } = await import('./infographic-runtime')
  const host = document.createElement('div')
  host.style.cssText = `position:absolute;left:-99999px;width:${Math.round(widthPx)}px;`
  document.body.appendChild(host)
  try {
    await renderInfographic(source, host, signal, {
      theme,
      widthPx: Math.round(widthPx),
      heightPx: 480
    })
    return infographicSvgFrom(host) ?? host.innerHTML
  } finally {
    host.remove()
  }
}

/**
 * Natural CSS size of an SVG: its root width/height in px, else its viewBox
 * (Mermaid emits width="100%" with a viewBox whose width is the diagram's
 * natural width). Ratio falls back to the browser's 300×150 default box.
 */
function svgIntrinsicSize(svg: string): { width?: number; ratio: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  const px = (name: string): number | undefined => {
    const match = new RegExp(`\\s${name}="\\s*([0-9.]+)(px)?\\s*"`, 'i').exec(tag)
    const value = match ? Number(match[1]) : NaN
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  const viewBox = /\sviewBox="\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*"/i.exec(
    tag
  )
  const vbWidth = viewBox ? Number(viewBox[1]) : NaN
  const vbHeight = viewBox ? Number(viewBox[2]) : NaN
  const width = px('width')
  const height = px('height')
  if (width && height) return { width, ratio: width / height }
  if (vbWidth > 0 && vbHeight > 0) return { width: width ?? vbWidth, ratio: vbWidth / vbHeight }
  return { width, ratio: 2 }
}

/**
 * Give the root <svg> an explicit pixel size. Mermaid emits width="100%" and no
 * height, which an <img> decodes into the 300×150 default box, so the scale
 * would apply to that instead of the page width.
 */
function sizeSvg(svg: string, widthPx: number): string {
  const open = /<svg\b[^>]*>/i.exec(svg)
  if (!open) return svg
  const tag = open[0]
  const heightPx = widthPx / svgIntrinsicSize(svg).ratio
  const sized = tag
    .replace(/\s(width|height)="[^"]*"/gi, '')
    .replace(/\sstyle="([^"]*)"/i, (_, style: string) => {
      const rest = style.replace(/max-width\s*:[^;]*;?/gi, '').trim()
      return rest ? ` style="${rest}"` : ''
    })
    .replace(/^<svg/i, `<svg width="${Math.round(widthPx)}" height="${Math.round(heightPx)}"`)
  return svg.slice(0, open.index) + sized + svg.slice(open.index + tag.length)
}

/**
 * CSS width the figure occupies on the page: the host width (writable width ×
 * attrs.width), but not more than the SVG's natural width unless `upscale`.
 * An infographic is laid out to the host width, so it always fills it.
 */
function cssWidthFor(
  target: FigureTarget,
  svg: string,
  hostWidth: number,
  upscale: boolean
): number {
  if (target.kind === 'infographicFigure' || upscale) return hostWidth
  const natural = svgIntrinsicSize(svg).width
  return natural ? Math.min(natural, hostWidth) : hostWidth
}

function pngSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read PNG size'))
    }
    image.src = url
  })
}

function yieldSlice(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function abortError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError')
}

/**
 * The figure as a PNG plus the CSS width it stands for. SVG sources are sized to
 * that width before rasterising; a bitmap keeps its own pixels (its CSS width is
 * its pixel width, which build.ts reads from widthPx).
 */
async function renderPng(
  target: FigureTarget,
  config: DocxExportConfig,
  hostWidth: number,
  signal: AbortSignal
): Promise<{ png: Blob; cssWidthPx?: number }> {
  if (target.bitmap) {
    const png = await blobToPng(target.bitmap, {
      background: config.figures.background,
      maxWidthPx: config.figures.maxWidthPx
    })
    return { png }
  }
  let svg = target.svgText ?? ''
  if (target.kind === 'mermaidFigure') {
    svg = await mermaidSvg(applyMermaidTheme(target.source, config.figures.mermaidTheme))
  } else if (target.kind === 'infographicFigure') {
    const themeOpt = infographicHasThemeLine(target.source)
      ? undefined
      : config.figures.infographicTheme
    svg = await infographicSvg(target.source, hostWidth, themeOpt, signal)
  }
  if (signal.aborted) throw abortError()
  if (!svg) throw new Error('Figure produced no SVG')
  const cssWidthPx = cssWidthFor(target, svg, hostWidth, config.figures.upscale)
  const toPng = testDeps.svgToPng ?? svgToPng
  const png = await toPng(sizeSvg(svg, cssWidthPx), {
    scale: config.figures.scale,
    background: config.figures.background,
    maxWidthPx: config.figures.maxWidthPx
  })
  return { png, cssWidthPx }
}

async function pngSizeOrEstimate(
  png: Blob,
  estimate: number
): Promise<{ width: number; height: number }> {
  if (testDeps.svgToPng) return { width: estimate, height: estimate }
  try {
    return await pngSize(png)
  } catch {
    return { width: estimate, height: estimate }
  }
}

export async function rasterizeFigures(
  docJson: JSONContent,
  config: DocxExportConfig,
  signal: AbortSignal,
  onProgress?: RasterizeProgress
): Promise<RenderedFigure[]> {
  const targets: FigureTarget[] = []
  walkFigures(docJson, targets)
  const geometry = pageGeometry(config)
  const out: RenderedFigure[] = []
  for (let i = 0; i < targets.length; i += 1) {
    if (signal.aborted) throw abortError()
    onProgress?.(i + 1, targets.length)
    const target = targets[i]
    const theme =
      target.kind === 'mermaidFigure'
        ? config.figures.mermaidTheme
        : target.kind === 'infographicFigure'
          ? config.figures.infographicTheme
          : ''
    const hostWidth = geometry.writableWidthPx * (target.widthPct / 100)
    const key = await cacheKey(target, theme, config, hostWidth)
    const alt = altFor(target)
    const hit = cache.get(key)
    if (hit && !hit.error) {
      // The key ignores block identity and caption, so both come from this target.
      out.push({ ...hit, blockId: target.blockId, kind: target.kind, alt, reused: true })
      await yieldSlice()
      continue
    }
    try {
      const { png, cssWidthPx } = await renderPng(target, config, hostWidth, signal)
      const pngBase64 = bytesToBase64(new Uint8Array(await png.arrayBuffer()))
      const size = await pngSizeOrEstimate(
        png,
        Math.round((cssWidthPx ?? hostWidth) * config.figures.scale)
      )
      const figure: RenderedFigure = {
        blockId: target.blockId,
        kind: target.kind,
        key,
        pngBase64,
        widthPx: size.width,
        heightPx: size.height,
        cssWidthPx,
        alt,
        reused: false
      }
      cache.set(key, figure)
      out.push(figure)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      out.push({
        blockId: target.blockId,
        kind: target.kind,
        key,
        alt,
        error: error instanceof Error ? error.message : 'Figure failed to render',
        reused: false
      })
    }
    await yieldSlice()
  }
  return out
}
