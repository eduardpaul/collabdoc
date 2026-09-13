import { getSchema, type JSONContent } from '@tiptap/core'
import { generateUniqueIds } from '@tiptap/extension-unique-id'
import type { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { LoroDoc } from 'loro-crdt'
import { createNodeFromLoroObj, updateLoroToPmState, type LoroDocType } from 'loro-prosemirror'
import { getRoot } from '@core/tree'
import { schemaExtensions } from '../editor/schema'

let cached: Schema | null = null

function editorSchema(): Schema {
  if (!cached) cached = getSchema(schemaExtensions())
  return cached
}

/** The document as Tiptap JSON, straight from Loro — no editor needed. */
export function docJsonFromLoro(doc: LoroDoc): JSONContent {
  return createNodeFromLoroObj(editorSchema(), getRoot(doc) as never, new Map()).toJSON()
}

/**
 * Write Tiptap JSON into a Loro doc the way the editor would, as one commit
 * (`loro-prosemirror` commits it itself, origin `loroSyncPlugin`). Used to
 * seed a fresh document from a file before the editor binds to it.
 */
export function writeJsonToLoro(doc: LoroDoc, content: JSONContent): void {
  const schema = editorSchema()
  // Parsed Markdown carries no block ids; the editor would assign them on its
  // first transaction, but the core needs them the moment the doc is seeded.
  const node = schema.nodeFromJSON(generateUniqueIds(content, schemaExtensions()))
  updateLoroToPmState(doc as LoroDocType, new Map(), EditorState.create({ schema, doc: node }))
}
