function randomHex(chars: number): string {
  // `crypto.randomUUID` is global in Node ≥ 19 and every supported browser.
  return crypto.randomUUID().replace(/-/g, '').slice(0, chars)
}

export function newBlockId(): string {
  return `b_${randomHex(10)}`
}

export function newThreadId(): string {
  return `c_${randomHex(10)}`
}

export function newReplyId(): string {
  return `r_${randomHex(10)}`
}

export function newDocId(): string {
  return crypto.randomUUID()
}
