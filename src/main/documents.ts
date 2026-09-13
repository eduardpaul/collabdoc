import { dialog, type BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'

export type DocumentReadResult =
  { ok: true; path: string; name: string; content: string } | { ok: false; error: string }

export type DocumentSavePayload = {
  path: string | null
  content: string
  suggestedName?: string
  extras?: { relativePath: string; base64: string }[]
}

export type BytesSavePayload = {
  suggestedName: string
  mime?: string
  base64: string
}

export type DocumentSaveResult =
  { ok: true; path: string; name: string } | { ok: false; error: string }

const filters = [
  { name: 'Documents', extensions: ['md', 'markdown', 'txt', 'collabdoc'] },
  { name: 'All files', extensions: ['*'] }
]

export async function openDocument(win: BrowserWindow): Promise<DocumentReadResult> {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open document',
    properties: ['openFile'],
    filters
  })
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, error: 'canceled' }
  }
  return readDocument(result.filePaths[0])
}

export async function readDocument(filePath: string): Promise<DocumentReadResult> {
  try {
    const content = await readFile(filePath, 'utf8')
    return { ok: true, path: filePath, name: basename(filePath), content }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to read file'
    }
  }
}

export async function saveDocument(
  win: BrowserWindow,
  payload: DocumentSavePayload
): Promise<DocumentSaveResult> {
  let filePath = payload.path
  if (!filePath) {
    const result = await dialog.showSaveDialog(win, {
      title: 'Save document',
      defaultPath: payload.suggestedName ?? 'Untitled.md',
      filters
    })
    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'canceled' }
    }
    filePath = result.filePath
  }

  try {
    await writeFile(filePath, payload.content, 'utf8')
    const folder = dirname(filePath)
    for (const extra of payload.extras ?? []) {
      const extraPath = join(folder, extra.relativePath)
      await mkdir(dirname(extraPath), { recursive: true })
      await writeFile(extraPath, Buffer.from(extra.base64, 'base64'))
    }
    return { ok: true, path: filePath, name: basename(filePath) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to save file'
    }
  }
}

export async function saveBytes(
  win: BrowserWindow,
  payload: BytesSavePayload
): Promise<DocumentSaveResult> {
  const result = await dialog.showSaveDialog(win, {
    title: 'Export',
    defaultPath: payload.suggestedName
  })
  if (result.canceled || !result.filePath) {
    return { ok: false, error: 'canceled' }
  }
  try {
    await writeFile(result.filePath, Buffer.from(payload.base64, 'base64'))
    return { ok: true, path: result.filePath, name: basename(result.filePath) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to export'
    }
  }
}

export async function readBytes(
  filePath: string
): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
  try {
    const buf = await readFile(filePath)
    return { ok: true, base64: buf.toString('base64') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to read' }
  }
}
