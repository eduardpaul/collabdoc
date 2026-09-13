import { dialog, type BrowserWindow } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { basename } from 'path'

export type DocumentReadResult =
  { ok: true; path: string; name: string; content: string } | { ok: false; error: string }

export type DocumentSavePayload = {
  path: string | null
  content: string
  suggestedName?: string
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
    return { ok: true, path: filePath, name: basename(filePath) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to save file'
    }
  }
}
