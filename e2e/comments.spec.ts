import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

type DebugEntry = { docId: string; text: string }
type PeerResult = { ok?: boolean; blocks?: { blockId: string }[]; threads?: { id: string }[] }
type CollabWindow = Window & {
  __collabEditor?: Editor
  __collabDebug?: () => Promise<DebugEntry[]>
  __collabPeer?: (
    docId: string,
    actorId: string,
    tool: string,
    args?: Record<string, unknown>
  ) => PeerResult
}

/** Comments end to end (09): the user, and an agent peer on the same hub. */
async function openEditor(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
  await page.getByTestId('editor-body').click()
  const docs = await page.evaluate(() => (window as CollabWindow).__collabDebug?.() ?? [])
  return docs[0].docId
}

async function peer(
  page: Page,
  docId: string,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<PeerResult> {
  return page.evaluate(
    ({ docId, tool, args }) => {
      const win = window as CollabWindow
      if (!win.__collabPeer) throw new Error('no in-page peer')
      return win.__collabPeer(docId, 'nova', tool, args)
    },
    { docId, tool, args }
  )
}

test('a thread opened on a selection is highlighted, answered by an agent, and resolved (AC-09.1/2/3/9)', async ({
  page
}) => {
  const docId = await openEditor(page)
  await page.keyboard.type('Some words here')
  await page.evaluate(() => {
    ;(window as CollabWindow).__collabEditor
      ?.chain()
      .focus()
      .setTextSelection({ from: 6, to: 11 })
      .run()
  })
  await page.keyboard.press('Control+Alt+m')
  const composer = page.getByTestId('comment-composer')
  await expect(composer).toBeVisible()
  await expect(composer).toContainText('words')
  await composer.getByLabel('New comment').fill('Why these? @nova')
  await composer.getByLabel('New comment').press('Control+Enter')

  const card = page.getByTestId('comment-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Why these?')
  // Nobody called nova is in the document yet: the handle stays plain text.
  await expect(card.getByTestId('mention-chip')).toHaveCount(0)
  await expect(page.locator('.comment-span')).toHaveText('words')

  // The agent sees the thread and replies; the reply lands on the card.
  const listed = await peer(page, docId, 'list_comments', {})
  const threadId = listed.threads?.[0]?.id
  expect(threadId).toBeTruthy()
  // Close the card first so the reply counts as unread.
  await card.locator('.comment-card__head').click()
  await peer(page, docId, 'reply_comment', { threadId, body: 'Because they matter.' })
  await expect(page.getByTestId('tab-comments').locator('.tabs__badge')).toHaveText('1')
  await card.locator('.comment-card__head').click()
  await expect(card).toContainText('Because they matter.')
  // Now that nova has written, the mention renders as a chip.
  await expect(card.getByTestId('mention-chip')).toHaveText('@nova')
  await expect(page.getByTestId('tab-comments').locator('.tabs__badge')).toHaveCount(0)

  // Resolve from the UI; the thread moves under Resolved.
  await card.getByRole('button', { name: 'Resolve' }).click()
  await expect(page.getByTestId('comment-card')).toHaveCount(0)
  await expect(page.locator('.comment-span')).toHaveCount(0)
  await page.getByRole('button', { name: /Resolved \/ orphaned/ }).click()
  await expect(page.getByTestId('comment-card')).toHaveCount(1)
  await expect(page.getByTestId('comment-card')).toContainText('resolved')
})

test('a whole-block thread from the toolbar marks the block edge and the highlight survives edits before it (AC-09.6, AC-09.10)', async ({
  page
}) => {
  const docId = await openEditor(page)
  await page.keyboard.type('Alpha beta gamma')
  const blockId = (await peer(page, docId, 'get_document')).blocks?.[0]?.blockId
  await peer(page, docId, 'add_comment', { blockId, body: 'span note', locator: { find: 'beta' } })
  await expect(page.locator('.comment-span')).toHaveText('beta')
  await page.keyboard.press('Home')
  await page.keyboard.type('Zero ')
  await expect(page.locator('.comment-span')).toHaveText('beta')

  await page.getByRole('button', { name: 'Comment' }).first().click()
  await page.getByTestId('comment-composer').getByLabel('New comment').fill('block note')
  await page.getByTestId('comment-composer').getByRole('button', { name: 'Comment' }).click()
  await expect(page.locator('.comment-block')).toHaveCount(1)
  await expect(page.getByTestId('comment-card')).toHaveCount(2)
})
