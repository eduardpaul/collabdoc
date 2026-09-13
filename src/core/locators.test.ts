// @vitest-environment node
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { encodeAnchor } from './anchors'
import { resolveRange, resolveRangeInString } from './locators'

function textDoc(content: string): { doc: LoroDoc; text: ReturnType<LoroDoc['getText']> } {
  const doc = new LoroDoc()
  const text = doc.getText('t')
  text.insert(0, content)
  doc.commit()
  return { doc, text }
}

describe('resolveRangeInString', () => {
  const content = 'the cat sat on the mat with the hat'

  it('find picks the first match by default and the nth with occurrence', () => {
    expect(resolveRangeInString(content, { find: 'the' }, 'span')).toEqual({
      ok: true,
      range: { start: 0, end: 3 }
    })
    expect(resolveRangeInString(content, { find: 'the', occurrence: 3 }, 'span')).toEqual({
      ok: true,
      range: { start: 28, end: 31 }
    })
    const missing = resolveRangeInString(content, { find: 'the', occurrence: 4 }, 'span')
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.message).toContain('occurrence 4')
  })

  it('after and before yield insertion points', () => {
    expect(resolveRangeInString(content, { after: 'cat' }, 'insert')).toEqual({
      ok: true,
      range: { start: 7, end: 7 }
    })
    expect(resolveRangeInString(content, { before: 'mat' }, 'insert')).toEqual({
      ok: true,
      range: { start: 19, end: 19 }
    })
    expect(resolveRangeInString(content, { after: 'dog' }, 'insert').ok).toBe(false)
    expect(resolveRangeInString(content, { before: 'dog' }, 'insert').ok).toBe(false)
  })

  it('numeric offsets need an expected snapshot for spans and must match it', () => {
    expect(resolveRangeInString(content, { start: 4, end: 7 }, 'span').ok).toBe(false)
    expect(resolveRangeInString(content, { start: 4, end: 7, expected: 'cat' }, 'span')).toEqual({
      ok: true,
      range: { start: 4, end: 7 }
    })
    const stale = resolveRangeInString(content, { start: 4, end: 7, expected: 'dog' }, 'span')
    expect(stale.ok).toBe(false)
    expect(!stale.ok && stale.message).toContain('found "cat"')
    expect(resolveRangeInString(content, { start: 4 }, 'insert')).toEqual({
      ok: true,
      range: { start: 4, end: 4 }
    })
    expect(resolveRangeInString(content, { start: 40 }, 'insert').ok).toBe(false)
    expect(resolveRangeInString(content, { start: 5, end: 2 }, 'span').ok).toBe(false)
  })

  it('an empty locator appends on insert and is refused for a span', () => {
    expect(resolveRangeInString(content, undefined, 'insert')).toEqual({
      ok: true,
      range: { start: content.length, end: content.length }
    })
    expect(resolveRangeInString(content, {}, 'insert').ok).toBe(true)
    expect(resolveRangeInString(content, { find: undefined }, 'insert').ok).toBe(true)
    expect(resolveRangeInString(content, {}, 'span').ok).toBe(false)
    expect(resolveRangeInString(content, { occurrence: 2 }, 'span').ok).toBe(false)
    expect(resolveRangeInString(content, { occurrence: 2 }, 'insert').ok).toBe(true)
  })
})

describe('resolveRange with anchors', () => {
  it('follows the text through a concurrent insert before the anchor', () => {
    const { doc, text } = textDoc('alpha beta gamma')
    const anchor = encodeAnchor(text.getCursor(6, 0)!)
    text.insert(0, 'ZERO ')
    doc.commit()
    expect(resolveRange(doc, text, { anchor }, 'insert')).toEqual({
      ok: true,
      range: { start: 11, end: 11 }
    })
    expect(resolveRange(doc, text, { anchor, length: 4 }, 'span')).toEqual({
      ok: true,
      range: { start: 11, end: 15 }
    })
    expect(text.toString().slice(11, 15)).toBe('beta')
  })

  it('needs a span for replacements and checks expected against the live text', () => {
    const { doc, text } = textDoc('alpha beta gamma')
    const anchor = encodeAnchor(text.getCursor(6, 0)!)
    const noSpan = resolveRange(doc, text, { anchor }, 'span')
    expect(noSpan.ok).toBe(false)
    expect(!noSpan.ok && noSpan.message).toContain('length')
    expect(resolveRange(doc, text, { anchor, expected: 'beta' }, 'span')).toEqual({
      ok: true,
      range: { start: 6, end: 10 }
    })
    expect(resolveRange(doc, text, { anchor, end: 10 }, 'span')).toEqual({
      ok: true,
      range: { start: 6, end: 10 }
    })
    expect(resolveRange(doc, text, { anchor, length: 0 }, 'span').ok).toBe(false)
    text.delete(6, 4)
    text.insert(6, 'BETA')
    doc.commit()
    // The anchored character is gone: the anchor moves, `expected` no longer
    // matches, and the call is refused rather than editing a wrong span.
    const stale = resolveRange(doc, text, { anchor, expected: 'beta' }, 'span')
    expect(stale.ok).toBe(false)
    expect(!stale.ok && stale.message).toContain('Expected "beta"')
  })

  it('refuses anchors that are corrupt or belong to another block', () => {
    const { doc, text } = textDoc('one')
    const other = doc.getText('other')
    other.insert(0, 'two')
    doc.commit()
    const foreign = encodeAnchor(other.getCursor(1, 0)!)
    expect(resolveRange(doc, text, { anchor: foreign }, 'insert').ok).toBe(false)
    expect(resolveRange(doc, text, { anchor: 'not base64!' }, 'insert').ok).toBe(false)
    expect(resolveRange(doc, text, { anchor: 'AAAA' }, 'insert').ok).toBe(false)
  })

  it('falls back to string resolution without an anchor', () => {
    const { doc, text } = textDoc('one two')
    expect(resolveRange(doc, text, { find: 'two' }, 'span')).toEqual({
      ok: true,
      range: { start: 4, end: 7 }
    })
  })
})
