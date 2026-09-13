import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { base64ToBytes, getAsset, hashFromSrc } from '../assets'

export async function svgToPng(svg: string): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Could not rasterize SVG'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, image.naturalWidth)
    canvas.height = Math.max(1, image.naturalHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('No canvas')
    }
    ctx.drawImage(image, 0, 0)
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result)
        } else {
          reject(new Error('PNG export failed'))
        }
      }, 'image/png')
    })
    return png
  } finally {
    URL.revokeObjectURL(url)
  }
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
