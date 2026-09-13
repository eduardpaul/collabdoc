import { DEFAULT_MERMAID } from './defaults'
import { createSyntaxFigure } from './syntax-figure'

export const MermaidFigure = createSyntaxFigure({
  name: 'mermaidFigure',
  lang: 'mermaid',
  defaultSource: DEFAULT_MERMAID,
  shortcut: 'Mod-Alt-m',
  render: async (source, el, signal) => {
    const { renderMermaid } = await import('./mermaid-runtime')
    await renderMermaid(source, el, signal)
  }
})
