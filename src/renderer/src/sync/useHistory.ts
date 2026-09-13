import { useEffect, useMemo, useState } from 'react'
import { addCheckpoint, listCheckpoints, type Checkpoint } from '@core/checkpoints'
import { HistoryIndex } from '@core/history-index'
import type { HistoryEntry } from '@core/history'
import { HISTORY_SETTLE_MS } from '@shared/constants'
import type { DocumentClient } from './DocumentClient'

export type HistoryView = {
  entries: HistoryEntry[]
  checkpoints: Checkpoint[]
  version: number
  index: HistoryIndex | null
  markCheckpoint: (name: string) => Checkpoint | null
}

export function useHistory(client: DocumentClient | null): HistoryView {
  const index = useMemo(() => (client ? new HistoryIndex(client.doc) : null), [client])
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!client || !index) return
    let timer: number | null = null
    const stop = client.subscribe((event) => {
      if (event.type !== 'change') return
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        index.refresh()
        setVersion((n) => n + 1)
      }, HISTORY_SETTLE_MS)
    })
    return () => {
      if (timer != null) window.clearTimeout(timer)
      stop()
    }
  }, [client, index])

  const entries = index?.list() ?? []
  const checkpoints = client ? listCheckpoints(client.doc) : []

  return {
    entries,
    checkpoints,
    version,
    index,
    markCheckpoint: (name) => {
      if (!client || !index) return null
      const marked = addCheckpoint(client.doc, {
        name,
        actorId: client.profile.actorId
      })
      index.refresh()
      setVersion((n) => n + 1)
      return marked
    }
  }
}
