import { markLibraryLoaded } from '../loaded'

type InfographicHandle = {
  render: (source: string) => void
  destroy?: () => void
}

export async function renderInfographic(
  source: string,
  el: HTMLElement,
  signal: AbortSignal,
  options: { theme?: string; widthPx?: number; heightPx?: number } = {}
): Promise<void> {
  const { Infographic } = await import('@antv/infographic')
  markLibraryLoaded('infographic')
  if (signal.aborted) {
    return
  }
  el.replaceChildren()
  const chart = new Infographic({
    container: el,
    width: options.widthPx ?? '100%',
    height: options.heightPx ?? '240px',
    theme: options.theme,
    editable: false
  }) as InfographicHandle
  try {
    chart.render(source)
  } catch (error) {
    chart.destroy?.()
    throw error
  }
  if (signal.aborted) {
    chart.destroy?.()
  }
}

export function infographicSvgFrom(el: HTMLElement): string | null {
  const svg = el.querySelector('svg')
  return svg?.outerHTML ?? null
}
