import { mergeAttributes, Node as TiptapNode } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { assetObjectUrl, getAsset, hashFromSrc, putDataUri } from '../assets'
import { isMarkdownSingleFile } from '../markdown-mode'
import { figureHost } from '../figure-host'
import { FIGURE_ALIGNS, type FigureAlign, type FigureWidth } from '../constants'

function parseAlign(value: unknown): FigureAlign {
  return FIGURE_ALIGNS.includes(value as FigureAlign) ? (value as FigureAlign) : 'center'
}

function parseWidth(value: unknown): FigureWidth | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (n === 50 || n === 75 || n === 100) {
    return n
  }
  return null
}

function captionFrom(node: JSONContent): string {
  return (node.content ?? []).map((child) => child.text ?? '').join('')
}

export const ImageFigure = TiptapNode.create({
  name: 'imageFigure',
  group: 'block',
  content: 'inline*',
  draggable: true,
  isolating: true,
  defining: true,

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (element) => {
          const img = element.querySelector('img')
          return img?.getAttribute('src') ?? element.getAttribute('data-src') ?? ''
        },
        renderHTML: (attributes) => ({ 'data-src': attributes.src as string })
      },
      alt: {
        default: '',
        parseHTML: (element) => element.querySelector('img')?.getAttribute('alt') ?? '',
        renderHTML: (attributes) => (attributes.alt ? { 'data-alt': attributes.alt as string } : {})
      },
      width: {
        default: null,
        parseHTML: (element) => parseWidth(element.getAttribute('data-width')),
        renderHTML: (attributes) =>
          attributes.width ? { 'data-width': String(attributes.width) } : {}
      },
      align: {
        default: 'center' as FigureAlign,
        parseHTML: (element) => parseAlign(element.getAttribute('data-align')),
        renderHTML: (attributes) => ({ 'data-align': parseAlign(attributes.align) })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="image"]', contentElement: 'figcaption' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'figure',
      mergeAttributes(HTMLAttributes, { 'data-type': 'image', class: 'doc-figure' }),
      ['img', { src: node.attrs.src, alt: node.attrs.alt, draggable: 'false' }],
      ['figcaption', 0]
    ]
  },

  addCommands() {
    return {
      setImageFigure:
        (options: { src: string; alt?: string }) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              src: options.src,
              alt: options.alt ?? '',
              width: null,
              align: 'center'
            },
            content: []
          })
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-p': () => {
        figureHost.onPickImage()
        return true
      }
    }
  },

  markdownTokenizer: {
    name: 'imageFigure',
    level: 'block',
    start: (src) => (src.startsWith('![') ? 0 : -1),
    tokenize: (src) => {
      const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)[ \t]*(?:\n|$)/.exec(src)
      if (!match) {
        return undefined
      }
      return {
        type: 'imageFigure',
        raw: match[0],
        alt: match[1] ?? '',
        src: match[2] ?? '',
        caption: match[3] ?? ''
      }
    }
  },

  parseMarkdown: (token) => {
    const rawSrc = String(token.src ?? '')
    let src = rawSrc
    if (rawSrc.startsWith('data:')) {
      src = rawSrc
    } else if (rawSrc.startsWith('assets/')) {
      const hash = hashFromSrc(rawSrc)
      src = hash ? `asset:${hash}` : rawSrc
    }
    return {
      type: 'imageFigure',
      attrs: { src, alt: String(token.alt ?? ''), width: null, align: 'center' },
      content: token.caption ? [{ type: 'text', text: String(token.caption) }] : []
    }
  },

  renderMarkdown: (node) => {
    const alt = String(node.attrs?.alt ?? '')
    const src = exportImageSrc(String(node.attrs?.src ?? ''), isMarkdownSingleFile())
    const caption = captionFrom(node)
    const title = caption ? ` "${caption.replace(/"/g, "'")}"` : ''
    return `![${alt}](${src}${title})`
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrapper = document.createElement('figure')
      wrapper.className = 'doc-figure'
      wrapper.dataset.type = 'image'

      const img = document.createElement('img')
      img.draggable = false
      wrapper.appendChild(img)

      const caption = document.createElement('figcaption')
      caption.className = 'doc-figure__caption'
      caption.contentEditable = 'true'
      wrapper.appendChild(caption)

      let current = node

      const apply = (): void => {
        const width = parseWidth(current.attrs.width)
        wrapper.dataset.align = parseAlign(current.attrs.align)
        if (width) {
          wrapper.dataset.width = String(width)
        } else {
          delete wrapper.dataset.width
        }
        wrapper.classList.toggle('is-empty-caption', current.content.size === 0)
        img.alt = String(current.attrs.alt ?? '')
        const url = assetObjectUrl(String(current.attrs.src ?? ''))
        img.src = url ?? ''
        img.classList.toggle('is-missing', !url)
      }

      apply()

      wrapper.addEventListener('click', (event) => {
        if (event.target instanceof Node && caption.contains(event.target)) {
          return
        }
        if (typeof getPos !== 'function') {
          return
        }
        const pos = getPos()
        if (typeof pos === 'number') {
          editor.commands.setNodeSelection(pos)
        }
      })

      return {
        dom: wrapper,
        contentDOM: caption,
        ignoreMutation: (mutation) => !caption.contains(mutation.target),
        update: (updated) => {
          if (updated.type.name !== 'imageFigure') {
            return false
          }
          current = updated
          apply()
          return true
        }
      }
    }
  }
})

export function exportImageSrc(src: string, singleFile: boolean): string {
  if (src.startsWith('data:')) {
    return singleFile ? src : src
  }
  const hash = hashFromSrc(src)
  if (!hash) {
    return src
  }
  const asset = getAsset(hash)
  if (singleFile && asset) {
    return `data:${asset.mime};base64,${asset.data}`
  }
  const ext = asset?.ext ?? 'png'
  return `assets/${hash}.${ext}`
}

export async function convertDataUriSrc(src: string): Promise<string> {
  if (!src.startsWith('data:')) {
    return src
  }
  const record = await putDataUri(src)
  return `asset:${record.sha256}`
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageFigure: {
      setImageFigure: (options: { src: string; alt?: string }) => ReturnType
    }
  }
}
