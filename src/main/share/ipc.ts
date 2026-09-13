import { BrowserWindow, ipcMain } from 'electron'
import type { ShareService, ShareUiState } from './service'
import type { GuestProfile } from './handshake'

export const SHARE_STATE_CHANNEL = 'share:state'
export const SHARE_ACTIVITY_CHANNEL = 'share:activity'

export function broadcastShare(state: ShareUiState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(SHARE_STATE_CHANNEL, state)
  }
}

export function broadcastShareActivity(summary: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(SHARE_ACTIVITY_CHANNEL, summary)
  }
}

export function registerShareIpc(share: ShareService): void {
  ipcMain.handle('share:start', async (_event, payload: unknown) => {
    const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    if (typeof rec.docId !== 'string') return { ok: false, error: 'Invalid docId' }
    try {
      const state = await share.start(
        rec.docId,
        typeof rec.hostName === 'string' ? rec.hostName : 'Host'
      )
      return { ok: true, state }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not share' }
    }
  })

  ipcMain.handle('share:stop', async () => {
    await share.stop()
    return { ok: true }
  })

  ipcMain.handle('share:removeGuest', async (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: 'Invalid guest' }
    await share.removeGuest(id)
    return { ok: true }
  })

  ipcMain.handle('share:join', async (_event, payload: unknown) => {
    const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    if (typeof rec.code !== 'string') return { ok: false, error: 'Enter a connection code.' }
    const profile = rec.profile as GuestProfile | undefined
    if (!profile?.userId) return { ok: false, error: 'Missing profile' }
    try {
      const joined = await share.join(
        rec.code,
        profile,
        typeof rec.expectedDocId === 'string' ? rec.expectedDocId : undefined
      )
      return { ok: true, ...joined, state: share.snapshot() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Join failed' }
    }
  })

  ipcMain.handle('share:leave', async () => {
    await share.stop()
    return { ok: true }
  })
}
