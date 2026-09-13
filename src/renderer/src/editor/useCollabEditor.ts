import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditor } from '@tiptap/react'
import { editorExtensions } from './extensions'
import { LoroCollab } from './loro-collab'
import { hrefFromClickTarget, isSafeHttpUrl, openExternalUrl } from './open-link'
import type { DocumentClient } from '../sync/DocumentClient'

/**
 * A Tiptap editor bound to a live `DocumentClient`. The Loro doc is the
 * content; Tiptap's own history is off (undo is Loro's, see 06).
 */
export function useCollabEditor(client: DocumentClient, editable = true): Editor {
  const editor = useEditor(
    {
      editable,
      extensions: [
        ...editorExtensions(),
        LoroCollab.configure({
          doc: client.doc,
          presence: client.presence,
          undoManager: client.undoManager,
          profile: client.profile
        })
      ],
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: 'tiptap',
          'aria-label': 'Document body',
          'data-testid': 'editor-body'
        },
        handleDOMEvents: {
          click: (_view, event) => {
            const href = hrefFromClickTarget(event.target)
            if (!href) {
              return false
            }
            event.preventDefault()
            event.stopPropagation()
            if (isSafeHttpUrl(href)) {
              openExternalUrl(href)
            }
            return true
          },
          auxclick: (_view, event) => {
            const href = hrefFromClickTarget(event.target)
            if (!href) {
              return false
            }
            event.preventDefault()
            return true
          }
        }
      }
    },
    [client]
  )

  useEffect(() => {
    editor.setEditable(editable)
  }, [editor, editable])

  return editor
}
