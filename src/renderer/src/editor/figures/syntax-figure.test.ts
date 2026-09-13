import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../extensions'
import { paintCount, renderCacheKey, resetRenderCache } from './render-cache'
import { setSyntaxRendererForTests } from './syntax-figure'
import { DEFAULT_MERMAID } from './defaults'

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) {
    editors.pop()?.destroy()
  }
  document.body.innerHTML = ''
  setSyntaxRendererForTests('mermaidFigure', null)
  setSyntaxRendererForTests('infographicFigure', null)
  resetRenderCache()
})

describe('syntax figures', () => {
  it('renders infographicFigure with a stub renderer', async () => {
    let calls = 0
    setSyntaxRendererForTests('infographicFigure', async (source, el) => {
      calls += 1
      el.innerHTML = `<svg data-src="${source.length}"></svg>`
    })
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: editorExtensions(),
      content: {
        type: 'doc',
        content: [{ type: 'infographicFigure', attrs: { source: 'hello', align: 'center' } }]
      }
    })
    editors.push(editor)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBeGreaterThan(0)
    expect(editor.getJSON().content?.[0]?.type).toBe('infographicFigure')
  })

  it('does not touch the DOM after destroy mid-render', async () => {
    let finish: (() => void) | undefined
    setSyntaxRendererForTests('mermaidFigure', () => {
      return new Promise((resolve) => {
        finish = () => resolve()
      })
    })
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: editorExtensions(),
      content: {
        type: 'doc',
        content: [{ type: 'mermaidFigure', attrs: { source: DEFAULT_MERMAID, align: 'center' } }]
      }
    })
    editors.push(editor)
    editor.destroy()
    editors.pop()
    finish?.()
    await new Promise((r) => setTimeout(r, 20))
    expect(editor.isDestroyed).toBe(true)
  })

  it('renders identical sources once', async () => {
    resetRenderCache()
    const key = renderCacheKey('mermaidFigure', DEFAULT_MERMAID, 100)
    setSyntaxRendererForTests('mermaidFigure', async (_source, el) => {
      el.innerHTML = '<svg></svg>'
    })
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: editorExtensions(),
      content: {
        type: 'doc',
        content: [
          { type: 'mermaidFigure', attrs: { source: DEFAULT_MERMAID, align: 'center' } },
          { type: 'mermaidFigure', attrs: { source: DEFAULT_MERMAID, align: 'center' } }
        ]
      }
    })
    editors.push(editor)
    await new Promise((r) => setTimeout(r, 40))
    expect(paintCount(key)).toBe(1)
  })
})
