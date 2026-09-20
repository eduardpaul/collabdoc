// @vitest-environment node
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { DEFAULT_DOCX_CONFIG, normalizeDocxConfig } from '../../shared/docx-config'
import { ASSET_SRC_PREFIX } from '../../shared/constants'
import { createDocument } from '../document'
import { SyncHub } from '../hub'
import { addParagraph, expectOk, writer } from '../test-helpers'
import { findBlock, getChildren } from '../tree'
import type { MutationResult } from '../../shared/types'
import { LoroMap, LoroText } from 'loro-crdt'
import { NODE_NAME_KEY } from '../../shared/constants'
import { getAttrs } from '../tree'
import { buildDocx } from './build'
import { mmToDxa, pageGeometry } from './geometry'
import type { DocxAsset, RenderedFigure } from './types'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const ASSET_HASH = 'a'.repeat(64)

async function unpack(bytes: Uint8Array): Promise<{
  documentXml: string
  settingsXml: string
  stylesXml: string
  footerXml: string
  media: string[]
}> {
  const zip = await JSZip.loadAsync(bytes)
  const documentXml = (await zip.file('word/document.xml')?.async('string')) ?? ''
  const settingsXml = (await zip.file('word/settings.xml')?.async('string')) ?? ''
  const stylesXml = (await zip.file('word/styles.xml')?.async('string')) ?? ''
  const footerName = Object.keys(zip.files).find(
    (name) => name.startsWith('word/footer') && name.endsWith('.xml')
  )
  const footerXml = footerName ? ((await zip.file(footerName)?.async('string')) ?? '') : ''
  const media = Object.keys(zip.files)
    .filter((name) => name.startsWith('word/media/') && !name.endsWith('/'))
    .sort()
  return { documentXml, settingsXml, stylesXml, footerXml, media }
}

function xmlText(xml: string): string {
  const withoutFields = xml.split('<w:instrText').join('<dropped').split('</w:instrText>').join('')
  const parts = withoutFields.split('<')
  let text = parts[0] ?? ''
  for (let i = 1; i < parts.length; i += 1) {
    const gt = parts[i].indexOf('>')
    text += gt >= 0 ? parts[i].slice(gt + 1) : parts[i]
  }
  return text
    .split('&amp;')
    .join('&')
    .split('&lt;')
    .join('<')
    .split('&gt;')
    .join('>')
    .split('&quot;')
    .join('"')
}

async function exportDoc(
  hub: SyncHub,
  options: {
    config?: ReturnType<typeof normalizeDocxConfig>
    figures?: RenderedFigure[]
    assets?: DocxAsset[]
    author?: string
  } = {}
): Promise<Awaited<ReturnType<typeof buildDocx>>> {
  return buildDocx({
    doc: hub.doc,
    config: options.config ?? DEFAULT_DOCX_CONFIG,
    figures: options.figures,
    assets: options.assets,
    author: options.author ?? 'Ana'
  })
}

describe('page geometry', () => {
  it('matches the POC millimetre conversion (AC-22.4)', () => {
    expect(mmToDxa(210)).toBe(11906)
    expect(mmToDxa(297)).toBe(16838)
    expect(mmToDxa(20)).toBe(1134)
    expect(mmToDxa(18)).toBe(1020)
  })
})

describe('buildDocx', () => {
  it('writes A4 portrait geometry and honours Letter landscape (AC-22.4)', async () => {
    const hub = SyncHub.create({ title: 'Geo' })
    const a4 = await exportDoc(hub)
    const unpacked = await unpack(a4.bytes)
    expect(unpacked.documentXml).toMatch(/w:w="11906"/)
    expect(unpacked.documentXml).toMatch(/w:h="16838"/)
    expect(unpacked.documentXml).toMatch(/w:top="1134"/)
    expect(unpacked.documentXml).toMatch(/w:right="1020"/)
    expect(unpacked.documentXml).toMatch(/w:bottom="1134"/)
    expect(unpacked.documentXml).toMatch(/w:left="1020"/)

    const letter = normalizeDocxConfig({
      page: {
        size: 'Letter',
        orientation: 'landscape',
        marginsMm: { top: 15, right: 15, bottom: 15, left: 15 }
      }
    })
    const geo = pageGeometry(letter)
    expect(geo.landscape).toBe(true)
    const letterDoc = await exportDoc(hub, { config: letter })
    const letterXml = (await unpack(letterDoc.bytes)).documentXml
    expect(letterXml).toMatch(/w:w="15840"/)
    expect(letterXml).toMatch(/w:h="12240"/)
    expect(letterXml).toMatch(/w:orient="landscape"/)
    expect(letterXml).toMatch(new RegExp(`w:top="${mmToDxa(15)}"`))
  })

  it('emits a TOC field and updateFields only when enabled (AC-22.5)', async () => {
    const hub = SyncHub.create({ title: 'Contents doc' })
    const on = await exportDoc(hub)
    const onXml = await unpack(on.bytes)
    expect(onXml.documentXml).toMatch(/TOC \\h \\o &quot;1-3&quot;/)
    expect(onXml.settingsXml).toMatch(/<w:updateFields/)
    expect(onXml.documentXml).toContain('Contents doc')
    expect(onXml.documentXml).toContain('Ana')

    const off = await exportDoc(hub, {
      config: normalizeDocxConfig({ toc: { enabled: false }, titleBlock: { enabled: false } })
    })
    const offXml = await unpack(off.bytes)
    expect(offXml.documentXml).not.toMatch(/TOC \\o/)
    expect(offXml.settingsXml).not.toMatch(/<w:updateFields/)
    expect(offXml.documentXml).not.toContain('Contents')
  })

  it('maps headings to Heading1–4 with bookmarks and skipped-level warnings (AC-22.6)', async () => {
    const hub = SyncHub.create({ title: 'Headings' })
    const a = writer(hub, 'nova')
    const h1 = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'heading', attrs: { level: 1 }, text: 'One' }]
    }) as MutationResult
    expectOk(h1)
    const h3 = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'heading', attrs: { level: 3 }, text: 'Three' }]
    }) as MutationResult
    expectOk(h3)
    const h1b = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'heading', attrs: { level: 1 }, text: 'Two' }]
    }) as MutationResult
    expectOk(h1b)

    const result = await exportDoc(hub, {
      config: normalizeDocxConfig({ headings: { chapterPageBreaks: true } })
    })
    const xml = (await unpack(result.bytes)).documentXml
    expect(xml).toMatch(/w:pStyle w:val="Heading1"/)
    expect(xml).toMatch(/w:pStyle w:val="Heading3"/)
    expect(xml).toMatch(new RegExp(`w:name="b_${h1.blocks[0].blockId}"`))
    expect(xml).toMatch(/w:pageBreakBefore/)
    expect(result.warnings.some((w) => w.code === 'HEADING_LEVEL_SKIPPED')).toBe(true)
  })

  it('maps every allowed node and mark without warnings (AC-22.7)', async () => {
    const hub = SyncHub.create({ title: 'Corpus' })
    const a = writer(hub, 'nova')
    const para = addParagraph(
      a,
      'Bold italic underline strike code link highlight super sub @later'
    )
    expectOk(
      a.call('apply_marks', {
        blockId: para,
        marks: [
          { op: 'add', type: 'bold', range: { find: 'Bold' } },
          { op: 'add', type: 'italic', range: { find: 'italic' } },
          { op: 'add', type: 'underline', range: { find: 'underline' } },
          { op: 'add', type: 'strike', range: { find: 'strike' } },
          { op: 'add', type: 'code', range: { find: 'code' } },
          {
            op: 'add',
            type: 'link',
            attrs: { href: 'https://example.com' },
            range: { find: 'link' }
          },
          { op: 'add', type: 'highlight', range: { find: 'highlight' } },
          { op: 'add', type: 'superscript', range: { find: 'super' } },
          { op: 'add', type: 'subscript', range: { find: 'sub' } }
        ]
      })
    )
    const found = findBlock(hub.doc, para)
    if (found) {
      const mention = getChildren(found.node).insertContainer(
        getChildren(found.node).length,
        new LoroMap()
      )
      mention.set(NODE_NAME_KEY, 'mention')
      getAttrs(mention).set('handle', 'ana')
    }
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end' },
        blocks: [{ type: 'heading', attrs: { level: 2 }, text: 'Section' }]
      })
    )
    const quote = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'blockquote' }]
    }) as MutationResult
    expectOk(quote)
    const quoteList = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: quote.blocks[0].blockId },
      blocks: [{ type: 'bulletList' }]
    }) as MutationResult
    expectOk(quoteList)
    const quoteItem = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: quoteList.blocks[0].blockId },
      blocks: [{ type: 'listItem' }]
    }) as MutationResult
    expectOk(quoteItem)
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: quoteItem.blocks[0].blockId },
        blocks: [{ type: 'paragraph', text: 'Quoted item' }]
      })
    )
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end' },
        blocks: [{ type: 'codeBlock', text: 'line one\n\nline three' }]
      })
    )
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end' },
        blocks: [{ type: 'horizontalRule' }]
      })
    )
    const bullets = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'bulletList' }]
    }) as MutationResult
    expectOk(bullets)
    const item = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: bullets.blocks[0].blockId },
      blocks: [{ type: 'listItem' }]
    }) as MutationResult
    expectOk(item)
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: item.blocks[0].blockId },
        blocks: [{ type: 'paragraph', text: 'Outer' }]
      })
    )
    const nested = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: item.blocks[0].blockId },
      blocks: [{ type: 'bulletList' }]
    }) as MutationResult
    expectOk(nested)
    const nestedItem = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: nested.blocks[0].blockId },
      blocks: [{ type: 'listItem' }]
    }) as MutationResult
    expectOk(nestedItem)
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: nestedItem.blocks[0].blockId },
        blocks: [{ type: 'paragraph', text: 'Inner' }]
      })
    )
    const ordered = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'orderedList' }, { type: 'orderedList' }]
    }) as MutationResult
    expectOk(ordered)
    for (const list of ordered.blocks) {
      const li = a.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: list.blockId },
        blocks: [{ type: 'listItem' }]
      }) as MutationResult
      expectOk(li)
      expectOk(
        a.call('insert_blocks', {
          at: { relation: 'inside_end', blockId: li.blocks[0].blockId },
          blocks: [{ type: 'paragraph', text: 'Numbered' }]
        })
      )
    }
    const tasks = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'taskList' }]
    }) as MutationResult
    expectOk(tasks)
    const unchecked = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: tasks.blocks[0].blockId },
      blocks: [{ type: 'taskItem', attrs: { checked: false } }]
    }) as MutationResult
    expectOk(unchecked)
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: unchecked.blocks[0].blockId },
        blocks: [{ type: 'paragraph', text: 'Todo' }]
      })
    )
    const checked = a.call('insert_blocks', {
      at: { relation: 'inside_end', blockId: tasks.blocks[0].blockId },
      blocks: [{ type: 'taskItem', attrs: { checked: true } }]
    }) as MutationResult
    expectOk(checked)
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end', blockId: checked.blocks[0].blockId },
        blocks: [{ type: 'paragraph', text: 'Done' }]
      })
    )

    const result = await exportDoc(hub, {
      config: normalizeDocxConfig({ toc: { enabled: false } })
    })
    expect(result.warnings.filter((w) => w.code !== 'HEADING_LEVEL_SKIPPED')).toEqual([])
    const text = xmlText((await unpack(result.bytes)).documentXml)
    for (const piece of [
      'Bold',
      'italic',
      'underline',
      'strike',
      'code',
      'link',
      'highlight',
      'super',
      'sub',
      '@ana',
      'Section',
      'Quoted item',
      'line one',
      'line three',
      'Outer',
      'Inner',
      'Numbered',
      'Todo',
      'Done'
    ]) {
      expect(text, piece).toContain(piece)
    }
    expect(text).toContain('☐')
    expect(text).toContain('☑')
  })

  it('writes page numbers and curated fonts (AC-22.8)', async () => {
    const hub = SyncHub.create({ title: 'Footer' })
    const on = await unpack((await exportDoc(hub)).bytes)
    expect(on.footerXml).toMatch(/Page /)
    expect(on.stylesXml).toMatch(/Calibri/)

    const off = await unpack(
      (
        await exportDoc(hub, {
          config: normalizeDocxConfig({
            footer: { pageNumbers: false },
            typography: { body: 'Georgia', heading: 'Arial', mono: 'Courier New', baseSizePt: 12 }
          })
        })
      ).bytes
    )
    expect(off.footerXml).toBe('')
    expect(off.documentXml).not.toMatch(/>Page </)
    expect(off.stylesXml).toMatch(/Georgia/)
    expect(off.stylesXml).toMatch(/Arial/)
    expect(off.stylesXml).toMatch(/Courier New/)
    expect(off.stylesXml).not.toMatch(/Calibri/)
  })

  it('keeps marks on text runs after an inline mention', async () => {
    const hub = SyncHub.create({ title: 'Runs' })
    const a = writer(hub, 'nova')
    const para = addParagraph(a, 'Hi ')
    const found = findBlock(hub.doc, para)
    if (!found) throw new Error('paragraph not found')
    const children = getChildren(found.node)
    const mention = children.insertContainer(children.length, new LoroMap())
    mention.set(NODE_NAME_KEY, 'mention')
    getAttrs(mention).set('handle', 'ana')
    const tail = children.insertContainer(children.length, new LoroText())
    tail.insert(0, ' please review')
    tail.mark({ start: 1, end: 7 }, 'bold', true)
    hub.doc.commit()

    const result = await exportDoc(hub, {
      config: normalizeDocxConfig({ toc: { enabled: false } })
    })
    const xml = (await unpack(result.bytes)).documentXml
    const runs = [...xml.matchAll(/<w:r>(.*?)<\/w:r>/g)].map((m) => m[1])
    const bold = runs.filter((run) => run.includes('<w:b/>'))
    expect(bold).toHaveLength(1)
    expect(xmlText(bold[0])).toBe('please')
    expect(xmlText(xml)).toContain('Hi @ana please review')
  })

  it('defines Title and Heading1–4 once, in the configured heading font', async () => {
    const hub = SyncHub.create({ title: 'Styles' })
    const styles = (
      await unpack(
        (
          await exportDoc(hub, {
            config: normalizeDocxConfig({ typography: { heading: 'Georgia' } })
          })
        ).bytes
      )
    ).stylesXml
    for (const id of ['Title', 'Heading1', 'Heading2', 'Heading3', 'Heading4']) {
      const definitions = styles.split(`w:styleId="${id}"`).length - 1
      expect(definitions, id).toBe(1)
    }
    const heading1 = /<w:style [^>]*w:styleId="Heading1".*?<\/w:style>/.exec(styles)?.[0] ?? ''
    expect(heading1).toMatch(/w:ascii="Georgia"/)
    expect(heading1).toMatch(/w:keepNext/)
    expect(heading1).toMatch(/w:outlineLvl w:val="0"/)
    expect(heading1).not.toMatch(/2E74B5/)
  })

  it('embeds image assets once and placeholders missing ones (AC-22.11)', async () => {
    const hub = SyncHub.create({ title: 'Images' })
    const a = writer(hub, 'nova')
    const src = `${ASSET_SRC_PREFIX}${ASSET_HASH}`
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [
        { type: 'imageFigure', attrs: { src, alt: 'Chart', caption: 'First' } },
        { type: 'imageFigure', attrs: { src, caption: 'Second' } },
        {
          type: 'imageFigure',
          attrs: { src: `${ASSET_SRC_PREFIX}${'b'.repeat(64)}`, caption: 'Gone' }
        }
      ]
    }) as MutationResult
    expectOk(created)
    const png = Uint8Array.from(Buffer.from(PNG_B64, 'base64'))
    const result = await exportDoc(hub, {
      assets: [{ hash: ASSET_HASH, mime: 'image/png', bytes: png }]
    })
    const unpacked = await unpack(result.bytes)
    expect(unpacked.media).toHaveLength(1)
    expect(unpacked.documentXml).toMatch(/descr="Chart"/)
    expect(unpacked.documentXml).toContain('[missing image: Gone]')
    expect(result.warnings.some((w) => w.code === 'ASSET_MISSING')).toBe(true)
  })

  it('sizes raster assets from their headers and never upscales them (AC-22.11)', async () => {
    const hub = SyncHub.create({ title: 'Sizes' })
    const a = writer(hub, 'nova')
    const src = `${ASSET_SRC_PREFIX}${ASSET_HASH}`
    expectOk(
      a.call('insert_blocks', {
        at: { relation: 'inside_end' },
        blocks: [{ type: 'imageFigure', attrs: { src, caption: 'Dot' } }]
      })
    )
    const png = Uint8Array.from(Buffer.from(PNG_B64, 'base64'))
    const xml = (
      await unpack(
        (await exportDoc(hub, { assets: [{ hash: ASSET_HASH, mime: 'image/png', bytes: png }] }))
          .bytes
      )
    ).documentXml
    // The 1×1 PNG stays 1 px square: 9525 EMU per CSS pixel, not the writable width × 0.6.
    expect(xml).toMatch(/<wp:extent cx="9525" cy="9525"\/>/)
  })

  it('embeds formats Word cannot decode only through a rendered PNG', async () => {
    const hub = SyncHub.create({ title: 'WebP' })
    const a = writer(hub, 'nova')
    const src = `${ASSET_SRC_PREFIX}${ASSET_HASH}`
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [{ type: 'imageFigure', attrs: { src, caption: 'Photo' } }]
    }) as MutationResult
    expectOk(created)
    const webp = { hash: ASSET_HASH, mime: 'image/webp', bytes: new Uint8Array([82, 73, 70, 70]) }
    const without = await exportDoc(hub, { assets: [webp] })
    expect(without.warnings.map((w) => w.code)).toEqual(['FIGURE_RENDER_FAILED'])
    expect((await unpack(without.bytes)).media).toEqual([])

    const withPng = await exportDoc(hub, {
      assets: [webp],
      figures: [
        {
          blockId: created.blocks[0].blockId,
          key: 'k',
          pngBase64: PNG_B64,
          widthPx: 1,
          heightPx: 1,
          alt: 'Photo'
        }
      ]
    })
    expect(withPng.warnings).toEqual([])
    expect((await unpack(withPng.bytes)).media).toEqual([expect.stringMatching(/\.png$/)])
  })

  it('emits failed figures as code plus caption (AC-22.12)', async () => {
    const hub = SyncHub.create({ title: 'Fail' })
    const a = writer(hub, 'nova')
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [
        {
          type: 'mermaidFigure',
          text: 'flowchart LR\n  A --> B',
          attrs: { caption: 'Broken' }
        }
      ]
    }) as MutationResult
    expectOk(created)
    const blockId = created.blocks[0].blockId
    const result = await exportDoc(hub, {
      figures: [{ blockId, key: 'x', alt: 'Mermaid diagram', error: 'parse failed' }]
    })
    const xml = (await unpack(result.bytes)).documentXml
    expect(xml).toContain('flowchart LR')
    expect(xml).toContain('Broken')
    expect(result.warnings.some((w) => w.code === 'FIGURE_RENDER_FAILED')).toBe(true)
  })

  it('falls back hostile fonts and clamps margins (AC-22.16)', async () => {
    const hub = SyncHub.create({ title: 'Hostile' })
    const config = normalizeDocxConfig({
      typography: { body: '<script>' },
      page: { marginsMm: { left: -5, right: 99, top: 20, bottom: 20 } }
    })
    const xml = (await unpack((await exportDoc(hub, { config })).bytes)).stylesXml
    expect(xml).toMatch(/Calibri/)
    expect(xml).not.toMatch(/<script>/)
    expect(config.page.marginsMm.left).toBe(5)
    expect(config.page.marginsMm.right).toBe(50)
  })

  it('is deterministic for document.xml, styles.xml and media (AC-22.18)', async () => {
    const hub = SyncHub.create({ title: 'Same' })
    writer(hub, 'nova')
    addParagraph(writer(hub, 'nova'), 'Hello')
    const figures: RenderedFigure[] = []
    const first = await unpack((await exportDoc(hub, { figures })).bytes)
    const second = await unpack((await exportDoc(hub, { figures })).bytes)
    expect(first.documentXml).toBe(second.documentXml)
    expect(first.stylesXml).toBe(second.stylesXml)
    expect(first.media).toEqual(second.media)
  })

  it('numbers captions with a SEQ field (AC-22.10)', async () => {
    const hub = SyncHub.create({ title: 'Captions' })
    const a = writer(hub, 'nova')
    const created = a.call('insert_blocks', {
      at: { relation: 'inside_end' },
      blocks: [
        { type: 'mermaidFigure', text: 'flowchart LR\n  A --> B', attrs: { caption: 'Flow' } }
      ]
    }) as MutationResult
    expectOk(created)
    const blockId = created.blocks[0].blockId
    const result = await exportDoc(hub, {
      config: normalizeDocxConfig({ figures: { numberCaptions: true } }),
      figures: [
        {
          blockId,
          key: 'k',
          pngBase64: PNG_B64,
          widthPx: 400,
          heightPx: 200,
          cssWidthPx: 100,
          alt: 'A to B'
        }
      ]
    })
    const xml = (await unpack(result.bytes)).documentXml
    expect(xml).toMatch(/w:pStyle w:val="Caption"/)
    expect(xml).toMatch(/SEQ Figure/)
    expect(xml).toMatch(/descr="A to B"/)
    expect(xml).toMatch(/w:jc w:val="center"/)
  })
})

describe('empty document', () => {
  it('exports a brand-new document', async () => {
    const doc = createDocument({ title: 'Blank' })
    const result = await buildDocx({ doc, config: DEFAULT_DOCX_CONFIG, author: 'You' })
    expect(result.bytes.byteLength).toBeGreaterThan(1000)
    expect(result.warnings).toEqual([])
  })
})
