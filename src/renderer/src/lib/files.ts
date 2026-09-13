import type { JSONContent } from '@tiptap/core'
import { getAsset, hashFromSrc, putBytes, putDataUri } from '../editor/assets'
import { parseDocument, serializeDocument, titleFromPath } from './document-file'

export type LoadedDocument = {
  path: string | null
  title: string
  content: JSONContent
}

export async function hydrateImages(doc: JSONContent, mdPath: string | null): Promise<JSONContent> {
  const walk = async (node: JSONContent): Promise<JSONContent> => {
    const next: JSONContent = { ...node }
    if (node.type === 'imageFigure' && typeof node.attrs?.src === 'string') {
      const src = node.attrs.src
      try {
        if (src.startsWith('data:')) {
          const record = await putDataUri(src)
          next.attrs = { ...node.attrs, src: `asset:${record.sha256}` }
        } else if (mdPath && (src.startsWith('assets/') || src.startsWith('./assets/'))) {
          const relative = src.replace(/^\.\//, '')
          const bytes = await readRelativeBytes(mdPath, relative)
          if (bytes) {
            const hash = hashFromSrc(src)
            const ext = relative.split('.').pop() ?? 'png'
            const mime =
              ext === 'jpg' || ext === 'jpeg'
                ? 'image/jpeg'
                : ext === 'svg'
                  ? 'image/svg+xml'
                  : `image/${ext}`
            const record = await putBytes(bytes, mime)
            next.attrs = { ...node.attrs, src: `asset:${hash ?? record.sha256}` }
          }
        }
      } catch {
        next.attrs = node.attrs
      }
    }
    if (node.content) {
      next.content = await Promise.all(node.content.map(walk))
    }
    return next
  }
  return walk(doc)
}

function resolveBeside(filePath: string, relative: string): string {
  const slash = filePath.includes('\\') ? '\\' : '/'
  const dir = filePath.split(/[/\\]/).slice(0, -1).join(slash)
  return `${dir}${slash}${relative.replaceAll('/', slash)}`
}

async function readRelativeBytes(mdPath: string, relative: string): Promise<Uint8Array | null> {
  if (!window.api?.documents.readBytes) {
    return null
  }
  const result = await window.api.documents.readBytes(resolveBeside(mdPath, relative))
  if (!result.ok) {
    return null
  }
  const binary = atob(result.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function extrasFromDoc(doc: JSONContent): { relativePath: string; base64: string }[] {
  const extras: { relativePath: string; base64: string }[] = []
  const seen = new Set<string>()
  const visit = (node: JSONContent): void => {
    if (node.type === 'imageFigure' && typeof node.attrs?.src === 'string') {
      const hash = hashFromSrc(node.attrs.src)
      const asset = hash ? getAsset(hash) : undefined
      if (asset && !seen.has(asset.sha256)) {
        seen.add(asset.sha256)
        extras.push({ relativePath: `assets/${asset.sha256}.${asset.ext}`, base64: asset.data })
      }
    }
    for (const child of node.content ?? []) {
      visit(child)
    }
  }
  visit(doc)
  return extras
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
      void file.text().then(async (raw) => {
        const parsed = parseDocument(raw, titleFromPath(file.name))
        const content = await hydrateImages(parsed.content, null)
        resolve({ path: null, title: parsed.title, content })
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
  return pickFileInBrowser()
}

export async function readDocumentFromHost(_filePath: string): Promise<LoadedDocument> {
  void _filePath
  throw new Error('Native file access is only available in the desktop app')
}

export async function saveDocumentToHost(input: {
  path: string | null
  title: string
  content: JSONContent
}): Promise<{ path: string; title: string } | null> {
  const serialized = serializeDocument(input.title, input.content, { singleFile: true })
  const suggestedName = `${input.title.trim() || 'Untitled'}.md`
  downloadInBrowser(suggestedName, serialized)
  return { path: input.path ?? suggestedName, title: input.title }
}
