import { describe, expect, it } from 'vitest'
import { DEFAULT_DOCX_CONFIG, normalizeDocxConfig, summarizeDocxConfig } from './docx-config'

describe('normalizeDocxConfig', () => {
  it('fills defaults for missing and empty values', () => {
    expect(normalizeDocxConfig(undefined)).toEqual(DEFAULT_DOCX_CONFIG)
    expect(normalizeDocxConfig(null)).toEqual(DEFAULT_DOCX_CONFIG)
    expect(normalizeDocxConfig({})).toEqual(DEFAULT_DOCX_CONFIG)
  })

  it('keeps valid fields and drops unknown keys (AC-22.16)', () => {
    const out = normalizeDocxConfig({
      version: 99,
      extra: true,
      tables: { style: 'banded' },
      lang: 'en-GB',
      page: { size: 'Letter', orientation: 'landscape', surprise: 1 },
      typography: { body: 'Georgia' }
    })
    expect(out.version).toBe(1)
    expect(out.lang).toBe('en-GB')
    expect(out.page.size).toBe('Letter')
    expect(out.page.orientation).toBe('landscape')
    expect(out.typography.body).toBe('Georgia')
    expect(out.typography.heading).toBe('Calibri')
    expect(out).not.toHaveProperty('extra')
    expect(out).not.toHaveProperty('tables')
  })

  it('replaces hostile or out-of-range values field-by-field (AC-22.16)', () => {
    const out = normalizeDocxConfig({
      lang: '<script>',
      typography: { body: '<script>', heading: 'Comic Sans', mono: 'Wingdings', baseSizePt: 0 },
      page: {
        size: 'A3',
        orientation: 'upside-down',
        marginsMm: { top: -5, right: 90, bottom: 0, left: -5 }
      },
      figures: { scale: 99, maxWidthPx: -1, mermaidTheme: 'neon', background: 'magenta' },
      toc: { depth: 9, enabled: 'yes', title: 12 }
    })
    expect(out.lang).toBe('en-US')
    expect(out.typography.body).toBe('Calibri')
    expect(out.typography.heading).toBe('Calibri')
    expect(out.typography.mono).toBe('Consolas')
    expect(out.typography.baseSizePt).toBe(11)
    expect(out.page.size).toBe('A4')
    expect(out.page.orientation).toBe('portrait')
    expect(out.page.marginsMm.top).toBe(5)
    expect(out.page.marginsMm.right).toBe(50)
    expect(out.page.marginsMm.bottom).toBe(5)
    expect(out.page.marginsMm.left).toBe(5)
    expect(out.figures.scale).toBe(4)
    expect(out.figures.maxWidthPx).toBe(3000)
    expect(out.figures.mermaidTheme).toBe('neutral')
    expect(out.figures.background).toBe('white')
    expect(out.toc.depth).toBe(3)
    expect(out.toc.enabled).toBe(true)
    expect(out.toc.title).toBe('Contents')
  })

  it('keeps at least 60 mm of writable width', () => {
    const out = normalizeDocxConfig({
      page: {
        size: 'A4',
        orientation: 'portrait',
        marginsMm: { left: 50, right: 50, top: 20, bottom: 20 }
      }
    })
    expect(210 - out.page.marginsMm.left - out.page.marginsMm.right).toBeGreaterThanOrEqual(60)
  })
})

describe('summarizeDocxConfig', () => {
  it('renders a one-line summary', () => {
    expect(summarizeDocxConfig(DEFAULT_DOCX_CONFIG)).toBe(
      'A4 portrait · 20/18 mm · TOC to H3 · figures 4×'
    )
  })
})
