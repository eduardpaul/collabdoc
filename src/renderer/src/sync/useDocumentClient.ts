import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '../state/AppState'
import type { DocumentClient } from './DocumentClient'
import { getClient } from './clients'

/**
 * The live client for a session id, mirrored into the reducer: title edits
 * made through the document (by anyone) and the dirty flag flow from here.
 */
export function useDocumentClient(docId: string): DocumentClient | null {
  const { dispatch } = useAppState()
  const client = useMemo(() => liveClient(docId), [docId])
  const [detachedId, setDetachedId] = useState<string | null>(null)

  useEffect(() => {
    if (!client) {
      return
    }
    dispatch({ type: 'set-dirty', dirty: client.dirty })
    return client.subscribe((event) => {
      if (event.type === 'title') {
        dispatch({ type: 'set-title', title: event.title })
      } else if (event.type === 'dirty') {
        dispatch({ type: 'set-dirty', dirty: event.dirty })
      } else if (event.type === 'status' && event.status === 'detached') {
        setDetachedId(client.docId)
      }
    })
  }, [client, dispatch])

  return client && detachedId !== client.docId ? client : null
}

function liveClient(docId: string): DocumentClient | null {
  const client = getClient(docId)
  return client && client.status === 'live' ? client : null
}
