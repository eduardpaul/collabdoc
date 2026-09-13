import { useEffect, useRef } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { useEditor } from '@tiptap/react'
import { editorExtensions } from './extensions'
import { hrefFromClickTarget, isSafeHttpUrl, openExternalUrl } from './open-link'

export function useCollabEditor(options: {
  content: JSONContent
  onChange: (content: JSONContent) => void
}): Editor {
  const onChangeRef = useRef(options.onChange)
  useEffect(() => {
    onChangeRef.current = options.onChange
  }, [options.onChange])

  const editor = useEditor({
    extensions: editorExtensions(),
    content: options.content,
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
    },
    onUpdate: ({ editor: current }) => {
      onChangeRef.current(current.getJSON())
    }
  })

  return editor
}
