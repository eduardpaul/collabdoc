export type FigureHost = {
  onPickImage: () => void
  onNotice: (message: string) => void
  onMermaidPaste: (source: string) => void
}

export const figureHost: FigureHost = {
  onPickImage: () => undefined,
  onNotice: () => undefined,
  onMermaidPaste: () => undefined
}

export function configureFigureHost(next: Partial<FigureHost>): void {
  Object.assign(figureHost, next)
}
