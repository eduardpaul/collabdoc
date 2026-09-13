/// <reference types="vite/client" />

import type { Editor } from '@tiptap/core'

declare global {
  interface Window {
    __collabEditor?: Editor
  }
}

export {}
