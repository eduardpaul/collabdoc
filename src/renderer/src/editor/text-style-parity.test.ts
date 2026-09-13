import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { TEXT_STYLE_CONFIG } from './constants'
import { schemaExtensions } from './extensions'
import { checkTextStyleParity } from './text-style-parity'

describe('text style parity', () => {
  const schema = getSchema(schemaExtensions())

  it('covers every mark the editor schema defines', () => {
    for (const name of Object.keys(schema.marks)) {
      expect(TEXT_STYLE_CONFIG).toHaveProperty(name)
    }
  })

  it('agrees with what the agents are configured with', () => {
    expect(checkTextStyleParity(schema)).toEqual([])
  })
})
