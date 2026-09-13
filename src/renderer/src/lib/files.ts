import { parseDocument, serializeDocument, titleFromPath } from './document-file'
import { hasNativeDocuments } from './host'
import type { DocumentReadResult, DocumentSaveResult } from '../types'

export type LoadedDocument = {
  path: string | null
  title: string
  content: string
}

function asLoaded(result: Extract<DocumentReadResult, { ok: true }>): LoadedDocument {
  const parsed = parseDocument(result.content, titleFromPath(result.name))
  return { path: result.path, title: parsed.title, content: parsed.content }
}

function pickFileInBrowser(): Promise<LoadedDocument | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,.collabdoc,text/plain,text/markdown'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      void file.text().then((raw) => {
        const parsed = parseDocument(raw, titleFromPath(file.name))
        resolve({ path: null, title: parsed.title, content: parsed.content })
      })
    })
    input.click()
  })
}

function downloadInBrowser(name: string, content: string): void {
  const fileName = /\.(md|markdown|txt|collabdoc)$/i.test(name) ? name : `${name}.md`
  const blob = new Blob([content], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function openDocumentFromHost(): Promise<LoadedDocument | null> {
  if (!hasNativeDocuments()) {
    return pickFileInBrowser()
  }
  const result = await window.api!.documents.open()
  if (!result.ok) {
    throw new Error(result.error)
  }
  return asLoaded(result)
}

export async function readDocumentFromHost(filePath: string): Promise<LoadedDocument> {
  if (!hasNativeDocuments()) {
    throw new Error('Native file access is only available in the desktop app')
  }
  const result = await window.api!.documents.read(filePath)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return asLoaded(result)
}

export async function saveDocumentToHost(input: {
  path: string | null
  title: string
  content: string
}): Promise<{ path: string; title: string } | null> {
  const serialized = serializeDocument(input.title, input.content)
  const suggestedName = `${input.title.trim() || 'Untitled'}.md`

  if (!hasNativeDocuments()) {
    downloadInBrowser(suggestedName, serialized)
    return { path: input.path ?? suggestedName, title: input.title }
  }

  const result: DocumentSaveResult = await window.api!.documents.save({
    path: input.path,
    content: serialized,
    suggestedName
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return { path: result.path, title: input.title }
}
