export const DEFAULT_MERMAID = `flowchart LR
  A[Write] --> B[Review]
  B --> C[Publish]`

export const DEFAULT_INFOGRAPHIC = `infographic list-row-simple-horizontal-arrow
data
  lists
    - label Step 1
      desc Start
    - label Step 2
      desc In Progress
    - label Step 3
      desc Complete`

export const MERMAID_PREFIXES = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'erDiagram',
  'gantt',
  'pie',
  'mindmap',
  'timeline'
] as const

export function looksLikeMermaidSource(text: string): boolean {
  const first = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return MERMAID_PREFIXES.some(
    (prefix) =>
      first === prefix || first.startsWith(`${prefix} `) || first.startsWith(`${prefix}\t`)
  )
}
