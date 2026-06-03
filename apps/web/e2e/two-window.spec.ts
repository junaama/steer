import { test, expect, type Page } from '@playwright/test'

const HARNESS = '/e2e/harness.html'

async function freshPage(page: Page): Promise<void> {
  await page.goto(HARNESS)
  await page.evaluate(() => localStorage.removeItem('steer-e2e'))
  await page.reload()
}

/** The session row in the sidebar (distinct from the detail-pane <h1> title). */
function sidebarRow(page: Page, title: string) {
  return page.locator('.sidebar').getByText(title)
}

test.describe('two-window live sync (UI-AE5)', () => {
  test('a session created in window A appears live in window B', async ({ context }) => {
    const a = await context.newPage()
    const b = await context.newPage()
    await freshPage(a)
    await freshPage(b)

    // Window A creates a session.
    await a.getByRole('button', { name: 'New session' }).click()
    await expect(sidebarRow(a, 'Build the thing')).toBeVisible()

    // Window B reflects it without any manual refresh.
    await expect(sidebarRow(b, 'Build the thing')).toBeVisible()
  })

  test('approving a tool in window A updates window B live', async ({ context }) => {
    const a = await context.newPage()
    const b = await context.newPage()
    await freshPage(a)
    await freshPage(b)

    await a.getByRole('button', { name: 'New session' }).click()

    // Both windows open the same session.
    await sidebarRow(a, 'Build the thing').click()
    await sidebarRow(b, 'Build the thing').click()

    // Window A sees the pending write_file with its diff + Approve control.
    await expect(a.getByText('write_file')).toBeVisible()
    await expect(a.getByText('return session')).toBeVisible()

    // Approve in A → window B reflects the executed result live.
    await a.getByRole('button', { name: 'Approve' }).click()
    await expect(b.getByText('Wrote src/login.ts · +1 −1')).toBeVisible()
    // ...and the Approve control is gone in B (the tool is no longer pending).
    await expect(b.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  })
})
