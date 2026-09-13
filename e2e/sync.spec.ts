import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

type DebugEntry = {
  docId: string
  title: string
  subscribers: string[]
  changes: number
  text: string
}
type CollabWindow = Window & {
  __collabEditor?: Editor
  __collabDebug?: () => Promise<DebugEntry[]>
}

/**
 * Browser mode runs the same client code against an in-page hub over a real
 * MessageChannel, so what these tests see — frames, hub text, undo — is what
 * the Electron main process sees over its MessagePort.
 */
async function openEditor(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
}

async function hubDocs(page: Page): Promise<DebugEntry[]> {
  return page.evaluate(() => (window as CollabWindow).__collabDebug?.() ?? [])
}

test('a new document is exactly one hub with one subscriber', async ({ page }) => {
  await openEditor(page)
  const docs = await hubDocs(page)
  expect(docs).toHaveLength(1)
  expect(docs[0].title).toBe('Untitled')
  expect(docs[0].subscribers).toHaveLength(1)
})

test('typing reaches the hub and matches the editor text', async ({ page }) => {
  await openEditor(page)
  await page.getByTestId('editor-body').click()
  await page.keyboard.type('Hello hub')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second line')
  await expect.poll(async () => (await hubDocs(page))[0]?.text).toBe('Hello hub\nSecond line')
  const editorText = await page.evaluate(() => {
    const editor = (window as CollabWindow).__collabEditor
    const lines: string[] = []
    editor?.state.doc.forEach((node) => lines.push(node.textContent))
    return lines.join('\n')
  })
  expect(editorText).toBe('Hello hub\nSecond line')
  await expect(page.locator('.topbar__title .muted')).toContainText('Unsaved')
})

test('Mod+Z undoes the last local change through Loro', async ({ page }) => {
  await openEditor(page)
  await page.getByTestId('editor-body').click()
  await page.keyboard.type('keep ')
  // Past the 1 s idle that starts a new undo step (06).
  await page.waitForTimeout(1_100)
  await page.keyboard.type('drop')
  await expect.poll(async () => (await hubDocs(page))[0]?.text).toBe('keep drop')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await hubDocs(page))[0]?.text).toBe('keep ')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async () => (await hubDocs(page))[0]?.text).toBe('keep drop')
})

test('the title edit travels through the document', async ({ page }) => {
  await openEditor(page)
  await page.getByLabel('Document title').fill('Renamed')
  await expect.poll(async () => (await hubDocs(page))[0]?.title).toBe('Renamed')
})

test('going home releases the document', async ({ page }) => {
  await openEditor(page)
  await page.getByLabel('Back to documents').click()
  await page.getByTestId('new-document').waitFor()
  await expect.poll(async () => (await hubDocs(page)).length).toBe(0)
})
