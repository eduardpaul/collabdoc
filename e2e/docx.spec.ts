import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

type CollabWindow = Window & {
  __collabEditor?: Editor
  __collabLoadedLibraries?: string[]
  __collabLastDocxExport?: {
    name: string
    report: { figures: Array<{ reused: boolean; widthPx: number }>; warnings: unknown[] }
  }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
}

async function openFileMenu(page: Page): Promise<void> {
  await page.getByTestId('file-menu').click()
  await expect(page.getByTestId('file-menu-list')).toBeVisible()
}

test('Export to Word dialog opens, saves settings, and cancel changes nothing (AC-22.2)', async ({
  page
}) => {
  await openEditor(page)
  await openFileMenu(page)
  await page.getByTestId('file-menu-export-docx').click()
  await expect(page.getByTestId('docx-export-dialog')).toBeVisible()
  await expect(page.getByTestId('docx-export-summary')).toContainText('A4 portrait')
  await page.getByLabel('Size').selectOption('Letter')
  await page.getByTestId('docx-export-save-settings').click()
  await expect(page.getByText('Export settings saved')).toBeVisible()
  await page.getByTestId('docx-export-cancel').click()
  await expect(page.getByTestId('docx-export-dialog')).toHaveCount(0)
})

test('Save As in browser offers Markdown and Word (AC-22.1)', async ({ page }) => {
  await openEditor(page)
  await openFileMenu(page)
  await page.getByTestId('file-menu-save-as').click()
  await expect(page.getByTestId('save-as-dialog')).toBeVisible()
  await expect(
    page.getByTestId('save-as-dialog').getByRole('button', { name: 'Markdown' })
  ).toBeVisible()
  await expect(page.getByTestId('save-as-docx')).toBeVisible()
})

test('exporting without figures does not load mermaid (AC-22.13)', async ({ page }) => {
  await openEditor(page)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await openFileMenu(page)
      await page.getByTestId('file-menu-export-docx').click()
      await page.getByTestId('docx-export-submit').click()
    })()
  ])
  expect(download.suggestedFilename()).toMatch(/\.docx$/)
  const loaded = await page.evaluate(() => (window as CollabWindow).__collabLoadedLibraries ?? [])
  expect(loaded).not.toContain('mermaid')
  expect(loaded).not.toContain('infographic')
})

test('Mermaid and Infographic rasterise once then reuse (AC-22.9, AC-22.13)', async ({ page }) => {
  test.setTimeout(90_000)
  await openEditor(page)
  await page.evaluate(async () => {
    const editor = (window as CollabWindow).__collabEditor
    if (!editor) throw new Error('editor not mounted')
    // Wider than the writable A4 width so the raster is clamped to the page, not the diagram.
    editor.commands.setMermaidFigure({
      source:
        'flowchart LR\n  accDescr: Arrow from A to H\n  A --> B --> C --> D --> E --> F --> G --> H'
    })
    editor.commands.setInfographicFigure({
      source:
        'infographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label Step 1\n      desc Start'
    })
  })
  await page.waitForTimeout(1500)
  await openFileMenu(page)
  await page.getByTestId('file-menu-export-docx').click()
  await expect(page.getByTestId('docx-export-dialog')).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('docx-export-submit').click({ force: true })
  ])
  expect(download.suggestedFilename()).toMatch(/\.docx$/)
  const first = await page.evaluate(() => (window as CollabWindow).__collabLastDocxExport?.report)
  expect(first?.figures.length).toBeGreaterThanOrEqual(1)
  expect(first?.figures.every((figure) => figure.reused === false)).toBe(true)
  // 4× the writable A4 width (≈ 658 px), not 4× the browser's 300 px default SVG box.
  expect(first?.figures.every((figure) => figure.widthPx >= 2400)).toBe(true)
  expect(first?.warnings).toEqual([])

  await openFileMenu(page)
  await page.getByTestId('file-menu-export-docx').click()
  await expect(page.getByTestId('docx-export-dialog')).toBeVisible()
  await page.getByTestId('docx-export-submit').click({ force: true })
  await page.waitForFunction(() => {
    const report = (window as CollabWindow).__collabLastDocxExport?.report
    return Boolean(
      report?.figures.length && report.figures.every((figure) => figure.reused === true)
    )
  })
})
