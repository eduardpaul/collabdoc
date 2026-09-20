import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_DOCX_CONFIG, normalizeDocxConfig } from '@shared/docx-config'
import { rasterizeFigures, resetFigurePngCache, setRasterizeDepsForTests } from './rasterize'

const PNG_BLOB = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

afterEach(() => {
  resetFigurePngCache()
  setRasterizeDepsForTests(null)
})

function docWith(content: object[]): { type: string; content: object[] } {
  return { type: 'doc', content }
}

describe('rasterizeFigures', () => {
  it('extracts accDescr as alt text and caches by content (AC-22.13)', async () => {
    let mermaidCalls = 0
    setRasterizeDepsForTests({
      renderMermaid: async (source) => {
        mermaidCalls += 1
        return `<svg width="100" height="50">${source.length}</svg>`
      },
      svgToPng: async () => PNG_BLOB
    })
    const json = docWith([
      {
        type: 'mermaidFigure',
        attrs: {
          blockId: 'b_one',
          source: 'flowchart LR\n  accDescr: From A to B\n  A --> B',
          width: 100
        },
        content: [{ type: 'text', text: 'Caption' }]
      }
    ])
    const first = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(first).toHaveLength(1)
    expect(first[0].alt).toBe('From A to B')
    expect(first[0].reused).toBe(false)
    expect(mermaidCalls).toBe(1)
    const second = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(second[0].reused).toBe(true)
    expect(mermaidCalls).toBe(1)
  })

  it('re-renders only the figure whose source changed', async () => {
    const sources: string[] = []
    setRasterizeDepsForTests({
      renderMermaid: async (source) => {
        sources.push(source)
        return `<svg>${source}</svg>`
      },
      svgToPng: async () => PNG_BLOB
    })
    const firstJson = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_a', source: 'graph TD\nA' } },
      { type: 'mermaidFigure', attrs: { blockId: 'b_b', source: 'graph TD\nB' } }
    ])
    await rasterizeFigures(firstJson, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(sources).toHaveLength(2)
    const secondJson = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_a', source: 'graph TD\nA' } },
      { type: 'mermaidFigure', attrs: { blockId: 'b_b', source: 'graph TD\nB2' } }
    ])
    const second = await rasterizeFigures(
      secondJson,
      DEFAULT_DOCX_CONFIG,
      new AbortController().signal
    )
    expect(second.find((f) => f.blockId === 'b_a')?.reused).toBe(true)
    expect(second.find((f) => f.blockId === 'b_b')?.reused).toBe(false)
    expect(sources).toHaveLength(3)
  })

  it('reports a cache hit under the block that asked for it', async () => {
    setRasterizeDepsForTests({
      renderMermaid: async () => '<svg></svg>',
      svgToPng: async () => PNG_BLOB
    })
    const json = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_first', source: 'graph TD\nA' } },
      {
        type: 'mermaidFigure',
        attrs: { blockId: 'b_second', source: 'graph TD\nA' },
        content: [{ type: 'text', text: 'Same again' }]
      }
    ])
    const figures = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(figures.map((f) => f.blockId)).toEqual(['b_first', 'b_second'])
    expect(figures[1].reused).toBe(true)
    expect(figures[1].alt).toBe('Same again')
  })

  it('rasterises Mermaid at the writable width, not the SVG default box (AC-22.9)', async () => {
    const seen: string[] = []
    setRasterizeDepsForTests({
      renderMermaid: async () =>
        '<svg viewBox="0 0 600 300" width="100%" style="max-width: 600px; background: white;"><g/></svg>',
      svgToPng: async (svg) => {
        seen.push(svg)
        return PNG_BLOB
      }
    })
    const json = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_w', source: 'graph TD\nA', width: 50 } }
    ])
    const figures = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    // A4 portrait with 18 mm side margins: 174 mm ≈ 658 px writable, half of it here.
    const host = ((210 - 36) * 96) / 25.4 / 2
    expect(seen[0]).toMatch(
      new RegExp(`^<svg width="${Math.round(host)}" height="${Math.round(host / 2)}"`)
    )
    expect(seen[0]).not.toMatch(/max-width/)
    expect(seen[0]).toMatch(/background: white/)
    expect(figures[0].cssWidthPx).toBeCloseTo(host, 0)
  })

  it('keeps a narrow diagram at its natural width unless upscale is on', async () => {
    const seen: string[] = []
    setRasterizeDepsForTests({
      renderMermaid: async () => '<svg viewBox="0 0 200 400" width="100%"><g/></svg>',
      svgToPng: async (svg) => {
        seen.push(svg)
        return PNG_BLOB
      }
    })
    const json = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_n', source: 'graph TD\nA' } }
    ])
    const natural = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(seen[0]).toMatch(/^<svg width="200" height="400"/)
    expect(natural[0].cssWidthPx).toBe(200)
    const upscale = normalizeDocxConfig({ figures: { upscale: true } })
    const stretched = await rasterizeFigures(json, upscale, new AbortController().signal)
    expect(stretched[0].cssWidthPx).toBeCloseTo(((210 - 36) * 96) / 25.4, 0)
  })

  it('re-renders when the page geometry or pixel cap changes', async () => {
    let renders = 0
    setRasterizeDepsForTests({
      renderMermaid: async () => {
        renders += 1
        return '<svg></svg>'
      },
      svgToPng: async () => PNG_BLOB
    })
    const json = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_g', source: 'graph TD\nA' } }
    ])
    const signal = new AbortController().signal
    await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, signal)
    const landscape = normalizeDocxConfig({ page: { orientation: 'landscape' } })
    expect((await rasterizeFigures(json, landscape, signal))[0].reused).toBe(false)
    const capped = normalizeDocxConfig({ figures: { maxWidthPx: 800 } })
    expect((await rasterizeFigures(json, capped, signal))[0].reused).toBe(false)
    expect((await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, signal))[0].reused).toBe(true)
    expect(renders).toBe(3)
  })

  it('does not load mermaid for a document without syntax figures (AC-22.13)', async () => {
    let mermaidCalls = 0
    setRasterizeDepsForTests({
      renderMermaid: async () => {
        mermaidCalls += 1
        return '<svg></svg>'
      },
      svgToPng: async () => PNG_BLOB
    })
    const json = docWith([{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }])
    const figures = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(figures).toEqual([])
    expect(mermaidCalls).toBe(0)
  })

  it('records an error instead of throwing when a figure fails (AC-22.12)', async () => {
    setRasterizeDepsForTests({
      renderMermaid: async () => {
        throw new Error('bad diagram')
      },
      svgToPng: async () => PNG_BLOB
    })
    const json = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_bad', source: 'not mermaid' } }
    ])
    const figures = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(figures[0].error).toMatch(/bad diagram/)
    expect(figures[0].pngBase64).toBeUndefined()
  })

  it('stops on cancel within one figure (AC-22.20)', async () => {
    const controller = new AbortController()
    setRasterizeDepsForTests({
      renderMermaid: async () => {
        controller.abort()
        return '<svg></svg>'
      },
      svgToPng: async () => PNG_BLOB
    })
    const json = docWith([
      { type: 'mermaidFigure', attrs: { blockId: 'b_1', source: 'graph TD\nA' } },
      { type: 'mermaidFigure', attrs: { blockId: 'b_2', source: 'graph TD\nB' } }
    ])
    await expect(
      rasterizeFigures(json, DEFAULT_DOCX_CONFIG, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('falls back caption then kind for alt text', async () => {
    setRasterizeDepsForTests({
      renderInfographic: async () => '<svg></svg>',
      svgToPng: async () => PNG_BLOB
    })
    const json = docWith([
      {
        type: 'infographicFigure',
        attrs: { blockId: 'b_info', source: 'infographic list-row-simple-horizontal-arrow' },
        content: [{ type: 'text', text: 'Steps' }]
      }
    ])
    const figures = await rasterizeFigures(json, DEFAULT_DOCX_CONFIG, new AbortController().signal)
    expect(figures[0].alt).toBe('Steps')
  })

  it('applies configured mermaid theme unless the source has init (AC-22.14)', async () => {
    const seen: string[] = []
    setRasterizeDepsForTests({
      renderMermaid: async (source) => {
        seen.push(source)
        return '<svg></svg>'
      },
      svgToPng: async () => PNG_BLOB
    })
    const dark = normalizeDocxConfig({ figures: { mermaidTheme: 'dark' } })
    await rasterizeFigures(
      docWith([{ type: 'mermaidFigure', attrs: { blockId: 'b_t', source: 'flowchart LR\nA' } }]),
      dark,
      new AbortController().signal
    )
    expect(seen[0]).toMatch(/"theme": "dark"/)
    await rasterizeFigures(
      docWith([
        {
          type: 'mermaidFigure',
          attrs: { blockId: 'b_i', source: '%%{init: {"theme": "forest"}}%%\nflowchart LR\nA' }
        }
      ]),
      dark,
      new AbortController().signal
    )
    expect(seen[1]).toMatch(/forest/)
    expect(seen[1]).not.toMatch(/"theme": "dark"/)
  })
})
