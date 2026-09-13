export const AUTOSAVE_IDLE_MS = 2_000
export const AUTOSAVE_MAX_MS = 30_000

/**
 * Debounce writes: 2 s after the last edit, and never more than 30 s after
 * the first unsaved edit.
 */
export class AutosaveScheduler {
  private readonly idle = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly max = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly firstAt = new Map<string, number>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly idleMs: number
  private readonly maxMs: number
  private readonly save: (id: string) => Promise<void>

  constructor(options: { save: (id: string) => Promise<void>; idleMs?: number; maxMs?: number }) {
    this.save = options.save
    this.idleMs = options.idleMs ?? AUTOSAVE_IDLE_MS
    this.maxMs = options.maxMs ?? AUTOSAVE_MAX_MS
  }

  touch(id: string): void {
    if (!this.firstAt.has(id)) {
      this.firstAt.set(id, Date.now())
      this.max.set(
        id,
        setTimeout(() => {
          void this.flush(id)
        }, this.maxMs)
      )
    }
    const previous = this.idle.get(id)
    if (previous) clearTimeout(previous)
    this.idle.set(
      id,
      setTimeout(() => {
        void this.flush(id)
      }, this.idleMs)
    )
  }

  async flush(id: string): Promise<void> {
    this.clearTimers(id)
    const running = this.pending.get(id)
    if (running) await running
    const work = this.save(id).finally(() => {
      if (this.pending.get(id) === work) this.pending.delete(id)
    })
    this.pending.set(id, work)
    await work
  }

  async flushAll(): Promise<void> {
    const ids = new Set([...this.firstAt.keys(), ...this.idle.keys(), ...this.pending.keys()])
    await Promise.all([...ids].map((docId) => this.flush(docId)))
  }

  clear(id: string): void {
    this.clearTimers(id)
  }

  dispose(): void {
    for (const id of new Set([...this.idle.keys(), ...this.max.keys()])) {
      this.clearTimers(id)
    }
  }

  private clearTimers(id: string): void {
    const idle = this.idle.get(id)
    if (idle) clearTimeout(idle)
    const max = this.max.get(id)
    if (max) clearTimeout(max)
    this.idle.delete(id)
    this.max.delete(id)
    this.firstAt.delete(id)
  }
}
