const loaded = new Set<string>()

export function markLibraryLoaded(name: string): void {
  loaded.add(name)
  if (typeof window !== 'undefined') {
    window.__collabLoadedLibraries = [...loaded]
  }
}

export function loadedLibraries(): string[] {
  return [...loaded]
}

export function resetLoadedLibraries(): void {
  loaded.clear()
  if (typeof window !== 'undefined') {
    window.__collabLoadedLibraries = []
  }
}

declare global {
  interface Window {
    __collabLoadedLibraries?: string[]
  }
}
