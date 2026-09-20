import { expect, test, type Page } from '@playwright/test'

/**
 * Backends (17) and sources (18) in the browser build, where there is no
 * main process: the tabs render their desktop-only notes, the agent roster
 * shows where each agent runs, and agents persisted by pre-17 builds
 * (`routing` / `mcpId`) migrate to `provider` without losing anything.
 */
async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('new-document').click()
  await page.getByTestId('editor-body').waitFor()
}

test('settings has Backends and Sources tabs; the old Local MCP tab is gone (AC-17.10)', async ({
  page
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: 'Manage agents' }).click()
  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveText(['You', 'LLM provider', 'Backends', 'Sources', 'Agents'])
  await page.getByRole('tab', { name: 'Backends' }).click()
  await expect(page.getByRole('dialog')).toContainText('CLI backends run in the desktop app')
  await page.getByRole('tab', { name: 'Sources' }).click()
  await expect(page.getByRole('dialog')).toContainText('managed by the desktop app')
  await page.getByRole('tab', { name: 'Agents' }).click()
  await expect(page.getByRole('dialog')).toContainText('never to the CLI that ran them')
  await expect(page.getByLabel('Runs on').first()).toHaveValue('default')
})

test('asking an agent without a backend explains what to do instead of pretending to run', async ({
  page
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: 'Invite' }).first().click()
  await page.getByRole('button', { name: 'Ask to draft' }).first().click()
  // The browser build has no main process to run a CLI in.
  await expect(page.locator('.notice')).toContainText('desktop app')
  await expect(page.locator('.agent-card').first()).not.toContainText('Working')
})

test('pre-17 persisted agents migrate: routing/mcpId become provider, handle and colour are filled in', async ({
  page
}) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.setItem(
      'collabdoc.v1',
      JSON.stringify({
        provider: {
          enabled: false,
          kind: 'openai-compatible',
          label: 'x',
          endpoint: '',
          apiKey: '',
          model: ''
        },
        mcp: [{ id: 'mcp_claude', kind: 'claude', status: 'connected' }],
        agents: [
          {
            id: 'agent_old',
            name: 'Old Writer',
            role: 'writer',
            persona: 'Legacy persona',
            skills: ['draft'],
            routing: 'mcp',
            mcpId: 'mcp_claude',
            invited: true,
            status: 'working'
          }
        ],
        mentionAutoSendSeconds: 5
      })
    )
  })
  await page.reload()
  // The app re-saves the migrated shape as soon as it mounts.
  await page.getByTestId('new-document').waitFor()
  await expect
    .poll(async () =>
      page.evaluate(() => JSON.parse(localStorage.getItem('collabdoc.v1') ?? '{}').mcp)
    )
    .toBeUndefined()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('collabdoc.v1') ?? '{}'))
  expect(stored.mcp).toBeUndefined()
  expect(stored.agents).toHaveLength(1)
  expect(stored.agents[0]).toMatchObject({
    id: 'agent_old',
    name: 'Old Writer',
    handle: 'old-writer',
    persona: 'Legacy persona',
    skills: ['draft'],
    provider: { kind: 'backend', id: 'claude-code' },
    sources: [],
    invited: false,
    status: 'idle'
  })
  expect(stored.agents[0].routing).toBeUndefined()
  expect(stored.agents[0].mcpId).toBeUndefined()
  expect(typeof stored.agents[0].color).toBe('string')
  await page.getByTestId('new-document').click()
  await expect(page.locator('.agent-card').first()).toContainText('Old Writer')
  await expect(page.locator('.agent-card').first()).toContainText('claude-code')
})
