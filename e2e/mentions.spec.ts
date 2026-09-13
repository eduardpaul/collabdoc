import { expect, test, type Page } from '@playwright/test'
import type { Editor } from '@tiptap/core'

type CollabWindow = Window & { __collabEditor?: Editor }

/**
 * Mentions end to end (10). The profile in `playwright.config.ts` is
 * "You" / @you, so a self-mention exercises both ends of a person request in
 * one browser: the chip is stamped by the sender and found by the recipient.
 */
async function openEditor(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
  await page.getByTestId('editor-body').click()
}

async function chipAttrs(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => {
    const editor = (window as CollabWindow).__collabEditor
    let attrs: Record<string, unknown> | null = null
    editor?.state.doc.descendants((node) => {
      if (attrs) return false
      if (node.type.name === 'mention') attrs = node.attrs
      return !attrs
    })
    return attrs
  })
}

test('@ opens a grouped picker; arrows and Enter insert a chip; @ + space stays literal (AC-10.1, AC-10.2)', async ({
  page
}) => {
  await openEditor(page)
  await page.keyboard.type('Hello @')
  const picker = page.getByTestId('mention-picker')
  await expect(picker).toBeVisible()
  await expect(picker).toContainText('People')
  await expect(picker).toContainText('@you')
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)

  await page.keyboard.type(' @ literal')
  await expect(page.getByTestId('mention-picker')).toHaveCount(0)
  await expect(page.getByTestId('editor-body')).toContainText('@ literal')

  await page.keyboard.press('Enter')
  await page.keyboard.type('@yo')
  await expect(page.getByTestId('mention-picker')).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  const chip = page.locator('.mention')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('@You')
  expect(await chipAttrs(page)).toMatchObject({ kind: 'person', handle: 'you', sentAt: null })
})

test('a person request lands in the inbox once and the chip shows sent, then seen (AC-10.3, AC-10.10)', async ({
  page
}) => {
  await openEditor(page)
  await page.keyboard.type('@yo')
  await page.getByTestId('mention-picker').waitFor()
  await page.keyboard.press('Enter')
  await page.keyboard.type('please check the numbers')
  await expect(page.getByTestId('inbox-badge')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.locator('.mention')).toHaveAttribute('data-state', 'sent')
  const first = await chipAttrs(page)
  expect(typeof first?.requestId).toBe('string')

  await expect(page.getByTestId('inbox-badge')).toHaveText('1')
  // Enter again is a plain newline: nothing is sent twice.
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('inbox-badge')).toHaveText('1')
  expect((await chipAttrs(page))?.requestId).toBe(first?.requestId)

  await page.getByTestId('inbox-bell').click()
  const panel = page.getByTestId('inbox-panel')
  await expect(panel).toContainText('please check the numbers')
  await panel.getByRole('button', { name: /please check/ }).click()
  await expect(page.getByTestId('inbox-badge')).toHaveCount(0)
  await expect(page.locator('.mention')).toHaveAttribute('data-state', 'seen')

  // The inbox is per install: a reload still has the entry, read.
  await page.reload()
  await page.getByTestId('inbox-bell').click()
  await expect(page.getByTestId('inbox-panel')).toContainText('please check the numbers')
  await expect(page.getByTestId('inbox-badge')).toHaveCount(0)
})

test('an agent request is dispatched once; with no provider it fails and offers retry (AC-10.5)', async ({
  page
}) => {
  await openEditor(page)
  // Invite the default writer so it is a participant.
  await page.getByRole('button', { name: 'Invite' }).first().click()
  await page.getByTestId('editor-body').click()
  await page.keyboard.type('@wri')
  const picker = page.getByTestId('mention-picker')
  await expect(picker).toContainText('Agents')
  await page.keyboard.press('Enter')
  await page.keyboard.type('draft an intro')
  await page.keyboard.press('Enter')
  const chip = page.locator('.mention')
  await expect(chip).toHaveAttribute('data-state', 'failed')
  const first = await chipAttrs(page)
  expect(first).toMatchObject({ kind: 'agent', handle: 'writer' })
  // Asking without a provider opens settings; close it and carry on.
  await page.keyboard.press('Escape')
  await page.getByTestId('editor-body').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  expect((await chipAttrs(page))?.requestId).toBe(first?.requestId)
  // Retry: a new request, again refused without a provider.
  await chip.click()
  await expect(chip).toHaveAttribute('data-state', 'failed')
  expect((await chipAttrs(page))?.requestId).not.toBe(first?.requestId)
})
