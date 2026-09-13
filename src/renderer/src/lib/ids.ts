const SHARE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

export function createShareCode(): string {
  let code = 'CD-'
  for (let i = 0; i < 6; i += 1) {
    code += SHARE_ALPHABET[Math.floor(Math.random() * SHARE_ALPHABET.length)]
  }
  return code
}

export function shareUrlForCode(code: string): string {
  const slug = code.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `https://${slug}.loca.lt`
}
