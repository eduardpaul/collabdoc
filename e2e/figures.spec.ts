import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

type CollabWindow = Window & { __collabEditor?: Editor; __collabLoadedLibraries?: string[] }

async function openEditor(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
}

test('empty documents never load mermaid or infographic', async ({ page }) => {
  await openEditor(page)
  await page.waitForTimeout(400)
  const loaded = await page.evaluate(() => (window as CollabWindow).__collabLoadedLibraries ?? [])
  expect(loaded).not.toContain('mermaid')
  expect(loaded).not.toContain('infographic')
})

test('mermaid javascript click does not navigate', async ({ page }) => {
  await openEditor(page)
  const navigated: string[] = []
  page.on('dialog', (dialog) => {
    navigated.push(dialog.message())
    void dialog.dismiss()
  })
  await page.evaluate(async () => {
    const editor = (window as CollabWindow).__collabEditor
    if (!editor) {
      throw new Error('editor not mounted')
    }
    editor.commands.setMermaidFigure({
      source: 'flowchart LR\n  A[x]\n  click A href "javascript:alert(1)"'
    })
  })
  await page.waitForTimeout(1500)
  expect(page.url()).toContain('127.0.0.1')
  expect(navigated).toEqual([])
  const loaded = await page.evaluate(() => (window as CollabWindow).__collabLoadedLibraries ?? [])
  expect(loaded).toContain('mermaid')
})
