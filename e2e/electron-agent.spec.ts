import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron, expect, test } from '@playwright/test'

/**
 * The whole path a person takes to have their own CLI agent work on a
 * document (17): open a document, Detect, invite the Writer, ask, and watch
 * the paragraph land attributed to the persona. Needs a built `out/` and a
 * signed-in CLI, so it is opt-in:
 *
 *   npx electron-vite build && COLLABDOC_ELECTRON_E2E=1 npx playwright test e2e/electron-agent.spec.ts
 */
test.skip(!process.env.COLLABDOC_ELECTRON_E2E, 'opt-in: needs a built app and a signed-in CLI')

test('a Writer persona on a real CLI backend drafts a paragraph into the open document', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'collabdoc-electron-'))
  await writeFile(
    join(userData, 'profile.json'),
    JSON.stringify({
      userId: 'e2e-user',
      name: 'Ana',
      handle: 'ana',
      color: '#c45c26',
      setupComplete: true
    })
  )
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    COLLABDOC_USER_DATA: userData,
    NO_SANDBOX: '1',
    ELECTRON_OZONE_PLATFORM_HINT: 'x11',
    GDK_BACKEND: 'x11'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.'], env, timeout: 60_000 })
  const page = await app.firstWindow()
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
  await page.getByTestId('editor-body').click()
  await page.keyboard.type('Tides are the rise and fall of sea levels.')

  // Backends tab: the machine's CLIs are detected for real.
  await page.getByRole('button', { name: 'Manage agents' }).click()
  await page.getByRole('tab', { name: 'Backends' }).click()
  await page.getByRole('button', { name: 'Detect all' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/signed in/, { timeout: 60_000 })
  await expect(dialog).toContainText('Claude Code')
  await page.getByRole('button', { name: 'Close' }).click()

  // Invite the Writer and ask.
  const writer = page.locator('.agent-card').first()
  await writer.getByRole('button', { name: 'Invite' }).click()
  await page
    .getByLabel('Ask an invited agent')
    .fill(
      'Insert exactly one short paragraph (two sentences) at the end explaining what causes tides. Do not change existing text.'
    )
  await page.getByRole('button', { name: /^Send to/ }).click()
  await expect(writer).toContainText(/Queued|Working/, { timeout: 10_000 })
  await expect(writer).toContainText(/Done · 1 edit/, { timeout: 240_000 })
  await expect(page.getByTestId('editor-body')).toContainText(/Moon|gravit/i)
  // Activity shows the run under the persona's name, not the CLI's.
  await page.locator('.tabs--rail button', { hasText: 'Activity' }).click()
  await expect(page.locator('.rail__body')).toContainText('Writer')
  await app.close()
})
