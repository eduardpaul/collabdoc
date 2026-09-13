import type { ShareState } from '../types'

export function emptyShare(): ShareState {
  return {
    active: false,
    announcing: false,
    url: null,
    code: null,
    role: null,
    guests: [],
    status: '',
    lockedUntil: 0,
    hostEnded: false,
    readOnly: false
  }
}
