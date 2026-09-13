import { expect, test } from '@playwright/test'

test('localStorage does not keep document content (AC-04.8)', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
  await page.getByTestId('editor-body').click()
  await page.keyboard.type('Secret draft body that must not leak into localStorage')
  await expect(page.locator('.topbar__title .muted')).toContainText('Unsaved')
  await page.waitForTimeout(400)
  const stored = await page.evaluate(() => localStorage.getItem('collabdoc.v1'))
  expect(stored ?? '').not.toContain('Secret draft body')
  expect(stored ?? '').not.toContain('"recents"')
})

test('going home from a typed draft asks before discarding', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
  await page.getByTestId('editor-body').click()
  await page.keyboard.type('Keep or drop')
  await page.getByLabel('Back to documents').click()
  await expect(page.getByRole('heading', { name: /draft|unsaved/i })).toBeVisible()
  await page.getByRole('button', { name: "Don't save" }).click()
  await page.getByTestId('new-document').waitFor()
})
