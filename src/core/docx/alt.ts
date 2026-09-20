/** accDescr from a Mermaid source, else `fallback`. */
export function mermaidAlt(source: string, fallback: string): string {
  return namedLine(source, 'accDescr') ?? fallback
}

/** `# accDescr:` / `// accDescr:` from Infographic source, else `fallback`. */
export function infographicAlt(source: string, fallback: string): string {
  return commentedLine(source, 'accDescr') ?? fallback
}

export function mermaidHasInit(source: string): boolean {
  return /%%\{\s*init/i.test(source)
}

export function applyMermaidTheme(source: string, theme: string): string {
  if (mermaidHasInit(source)) return source
  return `%%{init: {"theme": ${JSON.stringify(theme)}}}%%\n${source}`
}

export function infographicHasThemeLine(source: string): boolean {
  return /(?:^|\n)[ \t]*theme(?:[ \t]*:|[ \t])/i.test(source)
}

function namedLine(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'im'))
  const value = match?.[1]?.trim()
  return value ? value : null
}

function commentedLine(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^\\s*(?:#|//)\\s*${key}\\s*:\\s*(.+)$`, 'im'))
  const value = match?.[1]?.trim()
  return value ? value : null
}
