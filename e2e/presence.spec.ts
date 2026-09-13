import { expect, test } from '@playwright/test'

test.describe('first launch identity', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('asks for a display name and can be skipped (AC-07.1)', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('profile-setup')).toBeVisible()
    await page.getByTestId('profile-skip').click()
    await expect(page.getByTestId('profile-setup')).toHaveCount(0)
    const stored = await page.evaluate(() => localStorage.getItem('collabdoc.profile'))
    expect(stored).toContain('"setupComplete":true')
    expect(stored).toContain('"handle":"you"')
  })
})

test('session list shows the local user with handle, not a waiting row (AC-07.4)', async ({
  page
}) => {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
  const list = page.getByTestId('session-list')
  await expect(list).toContainText('@you')
  await expect(list).toContainText('You')
  await expect(list).not.toContainText('Waiting for peers')
})
