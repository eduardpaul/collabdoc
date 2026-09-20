/** The failure shape every `ipcMain.handle` in main returns instead of throwing. */
export function fail(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}
