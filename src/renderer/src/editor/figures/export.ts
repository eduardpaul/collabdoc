import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { base64ToBytes, getAsset, hashFromSrc } from '../assets'

export type SvgToPngOptions = {
  scale?: number
  background?: 'white' | 'transparent'
  maxWidthPx?: number
}

function svgDataUri(svg: string): string {
  const trimmed = svg.includes('xmlns=')
    ? svg
    : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result)
          return
        }
        try {
          const dataUrl = canvas.toDataURL('image/png')
          resolve(dataUrlToBlob(dataUrl))
        } catch (error) {
          reject(error instanceof Error ? error : new Error('PNG export failed'))
        }
      }, 'image/png')
    } catch {
      try {
        resolve(dataUrlToBlob(canvas.toDataURL('image/png')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('PNG export failed'))
      }
    }
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [, encoded = ''] = dataUrl.split(',', 2)
  return new Blob([base64ToBytes(encoded).buffer as ArrayBuffer], { type: 'image/png' })
}

export async function svgToPng(svg: string, options: SvgToPngOptions = {}): Promise<Blob> {
  return imageUrlToPng(svgDataUri(svg), options)
}

/** Re-encode any bitmap the browser can decode (WebP, AVIF, …) as PNG. */
export async function blobToPng(blob: Blob, options: SvgToPngOptions = {}): Promise<Blob> {
  const url = URL.createObjectURL(blob)
  try {
    return await imageUrlToPng(url, options)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function imageUrlToPng(url: string, options: SvgToPngOptions): Promise<Blob> {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Could not decode image'))
    image.src = url
  })
  const naturalWidth = Math.max(1, image.naturalWidth || image.width || 1)
  const naturalHeight = Math.max(1, image.naturalHeight || image.height || 1)
  let scale = options.scale ?? 1
  const maxWidth = options.maxWidthPx
  if (maxWidth && naturalWidth * scale > maxWidth) {
    scale = maxWidth / naturalWidth
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('No canvas')
  }
  if (options.background === 'white') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvasToPngBlob(canvas)
}

export async function exportSelectedFigure(
  editor: Editor,
  kind: 'svg' | 'png' | 'image'
): Promise<{ name: string; mime: string; bytes: Uint8Array } | null> {
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection)) {
    return null
  }
  const node = sel.node
  if (kind === 'image') {
    const hash = hashFromSrc(String(node.attrs.src ?? ''))
    const asset = hash ? getAsset(hash) : null
    if (!asset) {
      return null
    }
    return {
      name: `image.${asset.ext}`,
      mime: asset.mime,
      bytes: base64ToBytes(asset.data)
    }
  }
  let svg = ''
  if (node.type.name === 'mermaidFigure') {
    const { renderMermaidSvg } = await import('./mermaid-runtime')
    svg = await renderMermaidSvg(String(node.attrs.source ?? ''))
  } else if (node.type.name === 'infographicFigure') {
    const { infographicSvgFrom, renderInfographic } = await import('./infographic-runtime')
    const el = editor.view.nodeDOM(sel.from)
    if (el instanceof HTMLElement) {
      svg = infographicSvgFrom(el) ?? ''
    }
    if (!svg) {
      const holder = document.createElement('div')
      await renderInfographic(String(node.attrs.source ?? ''), holder, new AbortController().signal)
      svg = infographicSvgFrom(holder) ?? holder.innerHTML
    }
  }
  if (!svg) {
    return null
  }
  if (kind === 'svg') {
    return {
      name: `${node.type.name}.svg`,
      mime: 'image/svg+xml',
      bytes: new TextEncoder().encode(svg)
    }
  }
  const png = await svgToPng(svg)
  return {
    name: `${node.type.name}.png`,
    mime: 'image/png',
    bytes: new Uint8Array(await png.arrayBuffer())
  }
}
