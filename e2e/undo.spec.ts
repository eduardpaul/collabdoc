import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

type DebugEntry = { docId: string; text: string; changes: number }
type PeerResult = { ok?: boolean; blocks?: { blockId: string }[] }
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

/**
 * Undo at the UI level (06). The in-page hub exposes `__collabPeer`, an
 * agent session on the same hub, so a second participant can edit while the
 * user types — without a second browser.
 */
async function openEditor(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
  await page.getByTestId('editor-body').click()
  const docs = await hubDocs(page)
  return docs[0].docId
}

async function hubDocs(page: Page): Promise<DebugEntry[]> {
  return page.evaluate(() => (window as CollabWindow).__collabDebug?.() ?? [])
}

function hubText(page: Page): Promise<string | undefined> {
  return hubDocs(page).then((docs) => docs[0]?.text)
}

async function peer(
  page: Page,
  docId: string,
  tool: string,
  args: Record<string, unknown>
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

async function firstBlockId(page: Page, docId: string): Promise<string> {
  const result = await peer(page, docId, 'get_document', {})
  const id = result.blocks?.[0]?.blockId
  if (!id) throw new Error('no first block')
  return id
}

test('undo removes only my characters; a peer’s text typed inside stays intact (AC-06.3)', async ({
  page
}) => {
  const docId = await openEditor(page)
  await page.keyboard.type('hello world')
  await expect.poll(() => hubText(page)).toBe('hello world')
  const blockId = await firstBlockId(page, docId)
  await peer(page, docId, 'insert_text', { blockId, text: 'XYZ', at: { after: 'hello' } })
  await expect.poll(() => hubText(page)).toBe('helloXYZ world')
  await page.getByTestId('editor-body').press('ControlOrMeta+z')
  await expect.poll(() => hubText(page)).toBe('XYZ')
  // The editor shows the peer's text plus their caret label.
  await expect(page.getByTestId('editor-body')).toContainText('XYZ')
  await expect(page.getByTestId('editor-body')).not.toContainText('hello')
  await page.getByTestId('editor-body').press('ControlOrMeta+Shift+z')
  await expect.poll(() => hubText(page)).toBe('helloXYZ world')
})

test('undo reverts my block only, and the peer’s block keeps its text (AC-06.2)', async ({
  page
}) => {
  const docId = await openEditor(page)
  await page.keyboard.type('mine')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second')
  await expect.poll(() => hubText(page)).toBe('mine\nsecond')
  await page.waitForTimeout(1_100)
  const blockId = await firstBlockId(page, docId)
  await peer(page, docId, 'insert_text', { blockId, text: ' (agent)' })
  await expect.poll(() => hubText(page)).toBe('mine (agent)\nsecond')
  await page.keyboard.type(' more')
  await expect.poll(() => hubText(page)).toBe('mine (agent)\nsecond more')
  const changesBefore = (await hubDocs(page))[0].changes
  await page.getByTestId('editor-body').press('ControlOrMeta+z')
  await expect.poll(() => hubText(page)).toBe('mine (agent)\nsecond')
  expect((await hubDocs(page))[0].changes).toBe(changesBefore + 1)
})

test('toolbar Undo/Redo follow the stacks and the caret lands after the reverted range (AC-06.4, AC-06.5)', async ({
  page
}) => {
  await openEditor(page)
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  await expect(undo).toBeDisabled()
  await expect(redo).toBeDisabled()
  await page.keyboard.type('keep ')
  await page.waitForTimeout(1_100)
  await page.keyboard.type('drop')
  await expect.poll(() => hubText(page)).toBe('keep drop')
  await expect(undo).toBeEnabled()
  await expect(redo).toBeDisabled()
  await page.getByTestId('editor-body').press('ControlOrMeta+z')
  await expect.poll(() => hubText(page)).toBe('keep ')
  await expect(redo).toBeEnabled()
  const caret = await page.evaluate(
    () => (window as CollabWindow).__collabEditor?.state.selection.from
  )
  expect(caret).toBe(6)
  await page.keyboard.type('X')
  await expect.poll(() => hubText(page)).toBe('keep X')
  await expect(redo).toBeDisabled()
})
