import { mergeAttributes, Node as TiptapNode } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { FIGURE_ALIGNS, type FigureAlign, type FigureWidth } from '../constants'
import { cachedRender, renderCacheKey } from './render-cache'

export type SyntaxRenderFn = (source: string, el: HTMLElement, signal: AbortSignal) => Promise<void>

const testRenderers = new Map<string, SyntaxRenderFn>()

export function setSyntaxRendererForTests(name: string, render: SyntaxRenderFn | null): void {
  if (render) {
    testRenderers.set(name, render)
  } else {
    testRenderers.delete(name)
  }
}

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

function fenceMarkdown(lang: string, node: JSONContent): string {
  const source = String(node.attrs?.source ?? '')
  const caption = captionFrom(node).replace(/"/g, "'")
  const info = caption ? `${lang} caption="${caption}"` : lang
  return `\`\`\`${info}\n${source}\n\`\`\``
}

export function createSyntaxFigure(spec: {
  name: 'mermaidFigure' | 'infographicFigure'
  lang: 'mermaid' | 'infographic'
  defaultSource: string
  shortcut: string
  render: SyntaxRenderFn
}): ReturnType<typeof TiptapNode.create> {
  return TiptapNode.create({
    name: spec.name,
    group: 'block',
    content: 'inline*',
    draggable: true,
    isolating: true,
    defining: true,

    addAttributes() {
      return {
        source: {
          default: spec.defaultSource,
          parseHTML: (element) => element.getAttribute('data-source') || spec.defaultSource,
          renderHTML: (attributes) => ({ 'data-source': attributes.source as string })
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
      return [{ tag: `figure[data-type="${spec.lang}"]`, contentElement: 'figcaption' }]
    },

    renderHTML({ HTMLAttributes }) {
      return [
        'figure',
        mergeAttributes(HTMLAttributes, {
          'data-type': spec.lang,
          class: 'doc-figure'
        }),
        ['div', { class: 'doc-figure__diagram', contenteditable: 'false' }],
        ['figcaption', 0]
      ]
    },

    addCommands() {
      const insertName = spec.name === 'mermaidFigure' ? 'setMermaidFigure' : 'setInfographicFigure'
      const updateName =
        spec.name === 'mermaidFigure' ? 'updateMermaidSource' : 'updateInfographicSource'
      return {
        [insertName]:
          (options: { source?: string } = {}) =>
          ({ commands }) =>
            commands.insertContent({
              type: spec.name,
              attrs: {
                source: options.source ?? spec.defaultSource,
                width: null,
                align: 'center'
              },
              content: []
            }),
        [updateName]:
          (source: string) =>
          ({ commands }) =>
            commands.updateAttributes(spec.name, { source })
      }
    },

    addKeyboardShortcuts() {
      return {
        [spec.shortcut]: () =>
          spec.name === 'mermaidFigure'
            ? this.editor.commands.setMermaidFigure()
            : this.editor.commands.setInfographicFigure()
      }
    },

    markdownTokenizer: {
      name: spec.name,
      level: 'block',
      start: (src) => (src.startsWith(`\`\`\`${spec.lang}`) ? 0 : -1),
      tokenize: (src) => {
        const match = new RegExp(
          `^\`\`\`${spec.lang}(?:[ \\t]+caption="([^"]*)")?[ \\t]*\\n([\\s\\S]*?)\\n\`\`\`[ \\t]*(?:\\n|$)`
        ).exec(src)
        if (!match) {
          return undefined
        }
        return {
          type: spec.name,
          raw: match[0],
          caption: match[1] ?? '',
          source: match[2] ?? ''
        }
      }
    },

    parseMarkdown: (token) => ({
      type: spec.name,
      attrs: {
        source: String(token.source ?? spec.defaultSource),
        width: null,
        align: 'center'
      },
      content: token.caption ? [{ type: 'text', text: String(token.caption) }] : []
    }),

    renderMarkdown: (node) => fenceMarkdown(spec.lang, node),

    addNodeView() {
      return ({ node, editor, getPos }) => {
        const abort = new AbortController()
        const wrapper = document.createElement('figure')
        wrapper.className = 'doc-figure'
        wrapper.dataset.type = spec.lang

        const diagram = document.createElement('div')
        diagram.className = 'doc-figure__diagram'
        diagram.contentEditable = 'false'
        wrapper.appendChild(diagram)

        const error = document.createElement('div')
        error.className = 'doc-figure__error'
        error.hidden = true
        wrapper.appendChild(error)

        const caption = document.createElement('figcaption')
        caption.className = 'doc-figure__caption'
        caption.contentEditable = 'true'
        wrapper.appendChild(caption)

        let current = node
        let generation = 0

        const applyChrome = (): void => {
          const width = parseWidth(current.attrs.width)
          const align = parseAlign(current.attrs.align)
          wrapper.dataset.align = align
          if (width) {
            wrapper.dataset.width = String(width)
          } else {
            delete wrapper.dataset.width
          }
          wrapper.classList.toggle('is-empty-caption', current.content.size === 0)
        }

        const paint = (source: string): void => {
          const id = ++generation
          const key = renderCacheKey(spec.name, source, parseWidth(current.attrs.width))
          const render = testRenderers.get(spec.name) ?? spec.render
          void cachedRender(key, (el) => render(source, el, abort.signal), abort.signal)
            .then((html) => {
              if (abort.signal.aborted || id !== generation) {
                return
              }
              diagram.innerHTML = html
              error.hidden = true
              error.textContent = ''
            })
            .catch((err: unknown) => {
              if (abort.signal.aborted || id !== generation) {
                return
              }
              if (err instanceof DOMException && err.name === 'AbortError') {
                return
              }
              error.hidden = false
              error.textContent = formatRenderError(err)
            })
        }

        applyChrome()
        paint(String(current.attrs.source ?? spec.defaultSource))

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
            if (updated.type.name !== spec.name) {
              return false
            }
            const sourceChanged = updated.attrs.source !== current.attrs.source
            const sizeChanged = updated.attrs.width !== current.attrs.width
            current = updated
            applyChrome()
            if (sourceChanged || sizeChanged) {
              paint(String(updated.attrs.source ?? spec.defaultSource))
            }
            return true
          },
          destroy: () => {
            abort.abort()
            generation += 1
          }
        }
      }
    }
  })
}

function formatRenderError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Invalid figure source.'
  const line = /line\s+(\d+)/i.exec(message)
  return line ? `${message}` : message
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mermaidFigure: {
      setMermaidFigure: (options?: { source?: string }) => ReturnType
      updateMermaidSource: (source: string) => ReturnType
    }
    infographicFigure: {
      setInfographicFigure: (options?: { source?: string }) => ReturnType
      updateInfographicSource: (source: string) => ReturnType
    }
  }
}
