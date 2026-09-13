import { DEFAULT_INFOGRAPHIC } from './defaults'
import { createSyntaxFigure } from './syntax-figure'

export const InfographicFigure = createSyntaxFigure({
  name: 'infographicFigure',
  lang: 'infographic',
  defaultSource: DEFAULT_INFOGRAPHIC,
  shortcut: 'Mod-Alt-i',
  render: async (source, el, signal) => {
    const { renderInfographic } = await import('./infographic-runtime')
    await renderInfographic(source, el, signal)
  }
})
