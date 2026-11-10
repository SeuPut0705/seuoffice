/**
 * A file whose format has no co-editing adapter, asked for with `collab`: the page answers
 * `collab_unavailable`, and the host opens it again the way it did before co-editing, under
 * its edit lock (docs/seuoffice/공동-편집.md).
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import init, { HwpDocument } from '@rhwp/core'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const MEMO = resolve(repo, 'apps/hwp/tests/fixtures/memo.hwp')

test.beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

function textOf(bytes: Uint8Array): string {
  const doc = new HwpDocument(bytes)
  try {
    return doc.getTextFileText()
  } finally {
    doc.free()
  }
}

test('an hwp opened with collab ends up open under the edit lock, edits and saves without a version', async ({
  page,
}) => {
  const query = new URLSearchParams({
    collab: `hwp-recovery-${Date.now()}`,
    user: 'alice',
    name: 'alice',
    access: 'edit',
  })
  await page.goto(`/?${query}`)
  await page.locator('#edit').setChecked(true)
  await page.setInputFiles('#file', MEMO)

  const app = page.frameLocator('#viewer iframe')
  await expect(app.locator('.hwp-app[data-phase="ready"]')).toHaveCount(1, { timeout: 60_000 })
  await expect
    .poll(() =>
      page.evaluate(() => ({
        mode: window.seuLauncher!.mode,
        openError: window.seuLauncher!.openError,
      })),
    )
    .toEqual({ mode: 'locked', openError: 'collab_unavailable' })
  expect(await page.evaluate(() => window.seuLauncher!.collab)).toBeNull()
  await expect(page.locator('body')).not.toHaveAttribute('data-collab-phase')
  await expect(page.locator('#status')).toHaveText('memo.hwp')
  await expect(page.locator('#save')).toBeVisible()
  // there is no session whose file could be rescued
  expect(
    await page.evaluate(() => window.seuLauncher!.exportLocal().then(() => 'exported', String)),
  ).toContain('no co-edited document is open')

  const studio = app.frameLocator('.hwp-editor-host iframe')
  await expect(studio.locator('[data-cmd="ext:ieum-save"]')).toHaveCount(1, { timeout: 30_000 })
  const editor = page.frameLocator('#viewer iframe').locator('.hwp-editor-host iframe')
  const box = (await editor.boundingBox())!
  await page.mouse.click(box.x + box.width * 0.4, box.y + 300)
  await page.keyboard.type('SEURECOVER')
  await expect(page.locator('#status')).toContainText('(저장 안 함)')
  expect(await page.evaluate(() => window.seuLauncher!.save())).toBeNull()
  const stored = await page.evaluate(() => {
    const saved = window.seuLauncher!.saved!
    return { version: saved.version, bytes: Array.from(saved.bytes) }
  })
  expect(stored.version).toBeNull()
  expect(textOf(new Uint8Array(stored.bytes))).toContain('SEURECOVER')
})
