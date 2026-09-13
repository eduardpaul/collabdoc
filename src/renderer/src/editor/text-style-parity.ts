import type { Schema } from '@tiptap/pm/model'
import { TEXT_STYLE_CONFIG, type TextStyleExpand } from './constants'

/**
 * The browser and the agents have to agree on how marks expand.
 *
 * Returns one line per disagreeing mark, empty when they match.
 */
export function checkTextStyleParity(schema: Schema): string[] {
  const problems: string[] = []
  for (const [name, config] of Object.entries(TEXT_STYLE_CONFIG)) {
    const mark = schema.marks[name]
    if (!mark) {
      problems.push(`${name}: in TEXT_STYLE_CONFIG but not in the editor schema`)
      continue
    }
    const fromSchema: TextStyleExpand = mark.spec.inclusive !== false ? 'after' : 'none'
    if (fromSchema !== config.expand) {
      problems.push(
        `${name}: schema expands "${fromSchema}", TEXT_STYLE_CONFIG says "${config.expand}"`
      )
    }
  }
  return problems
}
