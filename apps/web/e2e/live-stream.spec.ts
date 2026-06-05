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

/**
 * U11 capstone (web side): the live streaming + diff-review experience across two
 * windows, mirroring the existing two-window e2e harness/setup exactly. Window A
 * drives a session whose assistant reply streams in incrementally and then shows a
 * file-edit diff that the operator approves; window B sees every step synced live
 * with no manual refresh. Same real Sidebar/SessionDetail/ToolCard/DiffView the
 * production app renders — only the cross-tab store is a BroadcastChannel stand-in
 * for Electric (the production Electric wiring is exercised by `docker compose up`).
 */
test.describe('two-window live streaming + diff-review (U11)', () => {
  test('window A streams text incrementally and approves a diff; window B sees it live', async ({ context }) => {
    const a = await context.newPage()
    const b = await context.newPage()
    await freshPage(a)
    await freshPage(b)

    // Window A starts a streaming session.
    await a.getByRole('button', { name: 'Stream session' }).click()
    await expect(sidebarRow(a, 'Stream the fix')).toBeVisible()
    // Window B reflects the new session without any manual refresh.
    await expect(sidebarRow(b, 'Stream the fix')).toBeVisible()

    // Both windows open the same session.
    await sidebarRow(a, 'Stream the fix').click()
    await sidebarRow(b, 'Stream the fix').click()

    // The assistant reply streams in as coarse delta rows: the transcript fills in
    // incrementally and coalesces into the full message — proving the live stream.
    const aBody = a.locator('.ev-message .ev-body')
    await expect(aBody).toContainText('Updating')
    await expect(aBody).toHaveText('Updating the login handler now.')
    // Window B sees the streamed text synced live, not just window A.
    await expect(b.locator('.ev-message .ev-body')).toHaveText('Updating the login handler now.')

    // Window A then shows the proposed edit as a reviewable diff with added/removed
    // lines and an Approve control — the file is NOT applied until approval.
    await expect(a.getByText('write_file')).toBeVisible()
    const diff = a.locator('[data-testid="diff"]')
    await expect(diff).toBeVisible()
    await expect(diff.locator('.diff-line[data-t="del"]')).toContainText('return null')
    await expect(diff.locator('.diff-line[data-t="add"]')).toContainText('return session')
    await expect(a.getByRole('button', { name: 'Approve' })).toBeVisible()
    // The result has not landed yet in either window (the edit is still pending).
    await expect(b.getByText('Wrote src/login.ts · +1 −1')).toHaveCount(0)

    // Approve the diff in A → window B reflects the applied edit live, and the
    // Approve control clears in B (the tool is no longer pending).
    await a.getByRole('button', { name: 'Approve' }).click()
    await expect(b.getByText('Wrote src/login.ts · +1 −1')).toBeVisible()
    await expect(b.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  })
})
