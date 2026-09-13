import { join } from 'path'

export function draftsDir(userData: string): string {
  return join(userData, 'drafts')
}

export function draftPath(userData: string, docId: string): string {
  return join(draftsDir(userData), `${docId}.collabdoc`)
}

export function recentsPath(userData: string): string {
  return join(userData, 'recents.json')
}

export function defaultCollabdocPath(documentsDir: string, title: string): string {
  return join(documentsDir, `${safeFileName(title)}.collabdoc`)
}

export function twinCollabdocPath(markdownPath: string): string {
  return markdownPath.replace(/\.(md|markdown|txt)$/i, '.collabdoc')
}

export function safeFileName(title: string): string {
  let out = ''
  for (const ch of title) {
    const code = ch.charCodeAt(0)
    if (code < 32 || '<>:"/\\|?*'.includes(ch)) continue
    out += ch
  }
  return out.trim() || 'Untitled'
}
