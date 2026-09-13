import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Slice } from '@tiptap/pm/model'
import { AssetError, putFile } from './assets'
import { figureHost } from './figure-host'
import { looksLikeMermaidSource } from './figures/defaults'
import type { JSONContent } from '@tiptap/core'
import { docToMarkdown, markdownToDoc } from './markdown'

export function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }
  return /^(#{1,4}\s|[-*+]\s|\d+\.\s|```|!\[|>\s|- \[[ xX]\])/m.test(trimmed)
}

export function sliceToMarkdown(slice: Slice): string {
  const json = slice.content.toJSON() as JSONContent | JSONContent[]
  const content = Array.isArray(json) ? json : json ? [json] : []
  return docToMarkdown({ type: 'doc', content })
}

let forcePlainPaste = false

export function armPlainPaste(): void {
  forcePlainPaste = true
}

export const ClipboardMarkdown = Extension.create({
  name: 'clipboardMarkdown',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          clipboardTextSerializer: (slice) => sliceToMarkdown(slice),
          handleKeyDown: (_view, event) => {
            const mod = event.metaKey || event.ctrlKey
            if (mod && event.shiftKey && event.key.toLowerCase() === 'v') {
              armPlainPaste()
            }
            return false
          },
          handlePaste: (view, event) => {
            const plain = forcePlainPaste
            forcePlainPaste = false
            const files = event.clipboardData?.files
            if (files && files.length) {
              const image = [...files].find((file) => file.type.startsWith('image/'))
              if (image) {
                event.preventDefault()
                void insertImageFile(image)
                return true
              }
            }
            const text = event.clipboardData?.getData('text/plain') ?? ''
            if (plain) {
              return false
            }
            if (looksLikeMermaidSource(text) && !text.includes('\n```')) {
              event.preventDefault()
              figureHost.onMermaidPaste(text)
              return true
            }
            if (looksLikeMarkdown(text) && !event.clipboardData?.getData('text/html')) {
              event.preventDefault()
              const json = markdownToDoc(text)
              editor.commands.insertContent(json)
              return true
            }
            if (looksLikeMarkdown(text) && event.clipboardData?.types.includes('text/plain')) {
              const html = event.clipboardData.getData('text/html')
              if (!html) {
                event.preventDefault()
                editor.commands.insertContent(markdownToDoc(text))
                return true
              }
            }
            void view
            return false
          },
          handleDrop: (_view, event) => {
            const files = event.dataTransfer?.files
            const image = files ? [...files].find((file) => file.type.startsWith('image/')) : null
            if (!image) {
              return false
            }
            event.preventDefault()
            void insertImageFile(image)
            return true
          }
        }
      })
    ]
  }
})

async function insertImageFile(file: File): Promise<void> {
  try {
    const record = await putFile(file)
    const editor = window.__collabEditor
    editor
      ?.chain()
      .focus()
      .setImageFigure({ src: `asset:${record.sha256}`, alt: file.name })
      .run()
  } catch (error) {
    const message = error instanceof AssetError ? error.message : 'Could not insert image.'
    figureHost.onNotice(message)
  }
}
