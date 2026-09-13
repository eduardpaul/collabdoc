import { markLibraryLoaded } from '../loaded'

let ready = false

export async function renderMermaidSvg(source: string): Promise<string> {
  const mermaid = (await import('mermaid')).default
  markLibraryLoaded('mermaid')
  if (!ready) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      fontFamily: 'Segoe UI, Inter, ui-sans-serif, system-ui, sans-serif',
      flowchart: { htmlLabels: false }
    })
    ready = true
  }
  const id = `mermaid-${crypto.randomUUID().replace(/-/g, '')}`
  const { svg } = await mermaid.render(id, source)
  return svg
}

export async function renderMermaid(
  source: string,
  el: HTMLElement,
  signal: AbortSignal
): Promise<void> {
  const svg = await renderMermaidSvg(source)
  if (signal.aborted) {
    return
  }
  el.innerHTML = svg
  const svgEl = el.querySelector('svg')
  if (svgEl) {
    svgEl.setAttribute('width', '100%')
    svgEl.removeAttribute('height')
    svgEl.style.height = 'auto'
    svgEl.style.maxWidth = '100%'
  }
}
