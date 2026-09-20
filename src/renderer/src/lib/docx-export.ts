import { readDocxConfig } from '@core/document'
import type { DocxExportReport, DocxExportWarning, RenderedFigure } from '@core/docx/types'
import { listAssets } from '@core/tree'
import type { DocxExportConfig } from '@shared/docx-config'
import { base64ToBytes, getAsset } from '../editor/assets'
import { rasterizeFigures } from '../editor/figures/rasterize'
import type { DocumentClient } from '../sync/DocumentClient'

export type DocxExportOutcome =
  | { ok: true; name: string; path: string; report: DocxExportReport }
  | { ok: false; error: string; canceled?: boolean }

function downloadBlob(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name.endsWith('.docx') ? name : `${name}.docx`
  anchor.click()
  URL.revokeObjectURL(url)
}

function assetsFromRenderer(
  client: DocumentClient
): { hash: string; mime: string; bytes: Uint8Array }[] {
  return listAssets(client.doc).flatMap((hash) => {
    const record = getAsset(hash)
    if (!record) return []
    return [{ hash, mime: record.mime, bytes: base64ToBytes(record.data) }]
  })
}

function figureReport(figures: RenderedFigure[]): DocxExportReport['figures'] {
  return figures.map((figure) => ({
    blockId: figure.blockId,
    kind: figure.kind ?? 'mermaidFigure',
    reused: Boolean(figure.reused),
    widthPx: figure.widthPx ?? 0,
    heightPx: figure.heightPx ?? 0
  }))
}

export async function runDocxExport(options: {
  client: DocumentClient
  config: DocxExportConfig
  author: string
  title: string
  path?: string
  signal: AbortSignal
  onProgress: (message: string) => void
}): Promise<DocxExportOutcome> {
  const started = Date.now()
  const { signal } = options
  try {
    const figures = await rasterizeFigures(
      options.client.toJSON(),
      options.config,
      signal,
      (current, total) => options.onProgress(`Rendering figure ${current} of ${total}…`)
    )
    if (signal.aborted) return { ok: false, error: 'canceled', canceled: true }
    const suggestedName = `${options.title.trim() || 'Untitled'}.docx`
    if (window.api?.documents.exportDocx) {
      const result = await window.api.documents.exportDocx({
        docId: options.client.docId,
        path: options.path,
        config: options.config,
        figures,
        author: options.author,
        suggestedName
      })
      if (!result.ok) return result
      const report: DocxExportReport = {
        durationMs: Date.now() - started,
        figures: figureReport(figures),
        warnings: result.warnings as DocxExportWarning[]
      }
      rememberLastExport(result.name, report)
      return { ok: true, name: result.name, path: result.path, report }
    }
    // Browser mode only: the desktop app builds in main, so keep `docx` out of the startup chunk.
    const { buildDocx } = await import('@core/docx/build')
    const built = await buildDocx({
      doc: options.client.doc,
      config: options.config,
      figures,
      assets: assetsFromRenderer(options.client),
      author: options.author
    })
    downloadBlob(suggestedName, built.bytes)
    const report: DocxExportReport = {
      durationMs: Date.now() - started,
      figures: figureReport(figures),
      warnings: built.warnings
    }
    rememberLastExport(suggestedName, report)
    return { ok: true, name: suggestedName, path: suggestedName, report }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, error: 'canceled', canceled: true }
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Export failed' }
  }
}

export function configForDocument(
  client: DocumentClient,
  defaults: DocxExportConfig
): DocxExportConfig {
  return readDocxConfig(client.doc) ?? defaults
}

/** Test hook read by e2e/docx.spec.ts. */
function rememberLastExport(name: string, report: DocxExportReport): void {
  ;(window as Window & { __collabLastDocxExport?: unknown }).__collabLastDocxExport = {
    name,
    report
  }
}
