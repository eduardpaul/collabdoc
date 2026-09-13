import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

type CollabWindow = Window & { __collabEditor?: Editor }

async function editorHandle(page: Page): Promise<void> {
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
}

test('typing stays under 50ms on a ~200 KB document', async ({ page }) => {
  await page.goto('/')
  await editorHandle(page)

  const size = await page.evaluate(() => {
    const editor = (window as CollabWindow).__collabEditor
    if (!editor) {
      throw new Error('editor not mounted')
    }
    const mermaid = {
      type: 'mermaidFigure',
      attrs: {
        source: 'flowchart LR\n  A[Write] --> B[Review]',
        align: 'center'
      }
    }
    const paragraphs = Array.from({ length: 2000 }, (_, index) => ({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `Paragraph ${index} lorem ipsum dolor sit amet, consectetur adipiscing elit.`
        }
      ]
    }))
    const figures = Array.from({ length: 20 }, () => mermaid)
    editor.commands.setContent({ type: 'doc', content: [...paragraphs, ...figures] })
    return JSON.stringify(editor.getJSON()).length
  })
  expect(size).toBeGreaterThan(180_000)

  await page.getByTestId('editor-body').click()

  const latency = await page.evaluate(async () => {
    const editor = (window as CollabWindow).__collabEditor
    if (!editor) {
      throw new Error('editor not mounted')
    }
    const start = performance.now()
    editor.chain().focus('end').insertContent('x').run()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    return performance.now() - start
  })

  expect(latency).toBeLessThan(50)
})
