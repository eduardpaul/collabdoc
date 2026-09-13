export function parseDocument(
  raw: string,
  fallbackTitle: string
): { title: string; content: string } {
  const match = raw.match(/^#\s+(.+)\r?\n?/)
  if (!match) {
    return { title: fallbackTitle, content: raw }
  }
  return {
    title: match[1].trim() || fallbackTitle,
    content: raw.slice(match[0].length).replace(/^\r?\n/, '')
  }
}

export function serializeDocument(title: string, content: string): string {
  const body = content.replace(/^\uFEFF/, '')
  return `# ${title.trim() || 'Untitled'}\n\n${body}`
}

export function previewOf(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function titleFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  return base.replace(/\.(md|markdown|txt|collabdoc)$/i, '') || 'Untitled'
}
