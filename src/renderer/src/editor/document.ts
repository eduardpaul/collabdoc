import type { JSONContent } from '@tiptap/core'
import { generateUniqueIds } from '@tiptap/extension-unique-id'
import { BLOCK_ID_ATTR, BLOCK_ID_TYPES } from './constants'
import { schemaExtensions } from './extensions'
import { markdownToDoc } from './markdown'

const BLOCK_ID_SET = new Set<string>(BLOCK_ID_TYPES)

export function emptyDoc(): JSONContent {
  return generateUniqueIds({ type: 'doc', content: [{ type: 'paragraph' }] }, schemaExtensions())
}

export function isDocJson(value: unknown): value is JSONContent {
  return Boolean(value && typeof value === 'object' && (value as JSONContent).type === 'doc')
}

export function coerceDocJson(value: unknown): JSONContent {
  if (isDocJson(value)) {
    return value
  }
  if (typeof value === 'string') {
    return markdownToDoc(value)
  }
  return emptyDoc()
}

export function textFromDoc(doc: JSONContent): string {
  const parts: string[] = []
  walk(doc, parts)
  return parts.join(' ')
}

function walk(node: JSONContent, parts: string[]): void {
  if (typeof node.text === 'string') {
    parts.push(node.text)
  }
  for (const child of node.content ?? []) {
    walk(child, parts)
  }
}

export function collectBlockIds(doc: JSONContent): string[] {
  const ids: string[] = []
  visit(doc, (node) => {
    if (!node.type || !BLOCK_ID_SET.has(node.type)) {
      return
    }
    const id = node.attrs?.[BLOCK_ID_ATTR]
    if (typeof id === 'string' && id) {
      ids.push(id)
    }
  })
  return ids
}

function visit(node: JSONContent, fn: (node: JSONContent) => void): void {
  fn(node)
  for (const child of node.content ?? []) {
    visit(child, fn)
  }
}
