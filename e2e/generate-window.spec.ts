import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

/**
 * The generate window ("make a new document from these files"), on the built
 * app: Home's three entry points, sizes / total / notices, an unsaved material
 * blocking "make" until its save button saved it, the window above an active
 * editor tab, and "make" opening a new tab with the request queued for that
 * tab only, which the mind map editor in it then takes.
 *
 * Nothing here reaches Claude or Codex. The receiving editor takes the request
 * and tries to run it, so before anything opens the main process's
 * subscription status handlers answer "not installed" (the send gate blocks the
 * run), the real status pushes are kept from the tabs, and `ai:stream` is a
 * recording stub that the test asserts was never called.
 */

/** where the screenshots for review go (defaults to e2e/artifacts/screenshots) */
const EVIDENCE_DIR = process.env.GENERATE_EVIDENCE_DIR
const shot = (name: string) =>
  EVIDENCE_DIR ? join(EVIDENCE_DIR, `${name}.png`) : screenshotPath(name)

async function generatePage(app: Parameters<typeof waitForPageWithUrl>[0]): Promise<Page> {
  const page = await waitForPageWithUrl(app, 'generate.html')
  await expect(page.getByTestId('generate-window')).toBeVisible()
  return page
}

/** the AI channels in the main process become stubs: nothing is signed in, and a stream is recorded, never run */
async function stubAi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, webContents }) => {
    const g = globalThis as Record<string, unknown>
    g.__generateE2eStreams = 0
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]) as {
      send: (channel: string, ...args: unknown[]) => void
    }
    const realSend = proto.send
    proto.send = function (this: unknown, channel: string, ...args: unknown[]) {
      if (channel === 'ai:subscription-changed') return
      return realSend.call(this, channel, ...args)
    }
    const statuses = {
      'claude-code': { provider: 'claude-code', state: 'not-installed', meteredAccepted: false },
      codex: { provider: 'codex', state: 'not-installed', meteredAccepted: false },
    }
    for (const channel of ['ai:subscription-statuses', 'ai:subscription-recheck']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => statuses)
    }
    ipcMain.removeHandler('ai:stream')
    ipcMain.handle('ai:stream', () => {
      g.__generateE2eStreams = (g.__generateE2eStreams as number) + 1
      throw new Error('ai:stream is stubbed in this test')
    })
  })
}

async function cancel(page: Page): Promise<void> {
  const closed = page.waitForEvent('close')
  // the click closes its own window: on a slow runner the page can be gone before the click returns
  await page
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
    .catch((err: unknown) => {
      if (!page.isClosed()) throw err
    })
  await closed
}

/** the main process's hand-off store, as plain data */
interface HandoffSnapshot {
  queued: Array<{ webContentsId: number; target: string; materials: string[]; text: string }>
  taken: number
}

test.describe('generate window', () => {
  test('entry points, materials, unsaved save, and the queued hand-off', async () => {
    test.setTimeout(240_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-generate-e2e-'))
    const lesson = join(dir, 'lesson.md')
    const big = join(dir, 'reading.txt')
    const outline = join(dir, 'outline.txt')
    const draft = join(dir, 'draft.md')
    const clip = join(dir, 'clip.mp4')
    const missing = join(dir, 'gone.docx')
    await writeFile(lesson, `# Plan\n\n${'A paragraph about the topic. '.repeat(330)}\n`)
    await writeFile(big, 'word '.repeat(24_000))
    await writeFile(outline, 'one\ntwo\nthree\n')
    await writeFile(draft, '# Draft\n\nfirst line\n')
    await writeFile(clip, 'not a video')
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'generate-window' })
    const { app, page } = launched
    await stubAi(app)
    const handoffs = () =>
      app.evaluate((): HandoffSnapshot => {
        const store = (globalThis as Record<symbol, unknown>)[
          Symbol.for('genoffice.generate-handoff')
        ] as
          | {
              queued: Map<
                number,
                { target: string; materials: Array<{ path: string }>; text: string }
              >
              taken: Map<number, unknown>
            }
          | undefined
        if (!store) return { queued: [], taken: 0 }
        return {
          queued: [...store.queued].map(([webContentsId, h]) => ({
            webContentsId,
            target: h.target,
            materials: h.materials.map((m) => m.path),
            text: h.text,
          })),
          taken: store.taken.size,
        }
      })
    try {
      await page.evaluate(
        async ([paths]) => {
          for (const p of paths) await window.aiOffice.toggleStar(p)
          await window.aiOffice.setStarredGroup(paths, 'Unit A')
        },
        [[lesson, big, outline]] as const,
      )

      // ── 1. Starred view: the group's "make a new document from this group" ──
      await page.locator('.nav-item', { hasText: 'Starred' }).click()
      await page.locator('.filter-pill', { hasText: 'Unit A' }).click()
      await page.getByTestId('home-generate-from-group').click()
      let gen = await generatePage(app)
      const rows = gen.getByTestId('gen-materials').locator('li')
      await expect(rows).toHaveCount(3)
      await expect(gen.locator('li[data-state="ready"]')).toHaveCount(3)
      for (const size of await gen.getByTestId('gen-item-size').allTextContents()) {
        expect(size).toMatch(/\d.*(kB|KB|MB|byte)/i)
      }
      await expect(gen.getByTestId('gen-total')).toContainText('3 files')
      // slides is the default kind: both notices (long material, usage)
      await expect(gen.locator('[data-notice="long"]')).toBeVisible()
      await expect(gen.locator('[data-notice="usage"]')).toBeVisible()
      await expect(gen.getByTestId('gen-make')).toBeEnabled()
      await gen.screenshot({ path: shot('generate-window-light') })
      // the long-material notice is for slides and html only
      await gen.locator('[data-kind="mindmap"]').click()
      await expect(gen.locator('[data-notice="long"]')).toHaveCount(0)
      await expect(gen.locator('[data-notice="usage"]')).toBeVisible()
      await gen.locator('[data-kind="slides"]').click()
      await page.evaluate(() => window.aiOffice.setTheme('dark'))
      await expect(gen.locator('html')).toHaveAttribute('data-theme', 'dark')
      await gen.screenshot({ path: shot('generate-window-dark') })
      await page.evaluate(() => window.aiOffice.setTheme('light'))
      await cancel(gen)

      // ── 2. The selection bar ──
      const checks = page.locator('.recent-row .row-check')
      await checks.nth(0).check()
      await checks.nth(1).check()
      await page.getByTestId('home-generate-from-selection').click()
      gen = await generatePage(app)
      await expect(gen.getByTestId('gen-materials').locator('li')).toHaveCount(2)
      await cancel(gen)
      await page.locator('.selection-action', { hasText: 'Cancel' }).click()

      // ── 3. The file-row menu ──
      const outlineRow = page.locator('.recent-row', { hasText: 'outline.txt' })
      await outlineRow.hover()
      await outlineRow.locator('.more-btn').click()
      await page.getByTestId('home-generate-from-file').click()
      gen = await generatePage(app)
      await expect(gen.getByTestId('gen-materials').locator('li')).toHaveCount(1)
      await expect(gen.locator('li[data-name="outline.txt"]')).toHaveAttribute(
        'data-state',
        'ready',
      )
      await cancel(gen)

      // ── 4. While an editor tab is active, with an unsaved material ──
      await page.evaluate((p) => window.aiOffice.openPath(p), draft)
      const editor = await waitForPageWithUrl(app, '://markdown/')
      await expect(editor.locator('.doc-editor h1')).toHaveText('Draft')
      await editor.locator('.doc-editor p').last().click()
      await editor.keyboard.press('End')
      await editor.keyboard.type(' and an unsaved edit')
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.aiOfficeTabs.list())).find((t) => t.active)?.kind,
        )
        .toBe('markdown')
      // Home is hidden behind the editor; its page still asks for the window
      await page.evaluate(
        (paths) => window.aiOfficeGenerate.openWithPaths(paths),
        [draft, lesson, missing, clip],
      )
      gen = await generatePage(app)
      await expect
        .poll(
          async () => {
            await gen.evaluate(() => window.aiOfficeGenerateWindow.refresh())
            return gen.locator('li[data-name="draft.md"][data-state="unsaved"]').count()
          },
          { timeout: 15_000 },
        )
        .toBe(1)
      // the window is a visible child of the shell window, above the editor view
      const placement = await app.evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows()
        const child = all.find((w) => w.webContents.getURL().includes('generate.html'))
        return {
          visible: child?.isVisible() ?? false,
          parentIsShell:
            !!child?.getParentWindow() &&
            !child.getParentWindow()!.webContents.getURL().includes('generate.html'),
          parent: child?.getParentWindow()?.getBounds() ?? null,
        }
      })
      expect(placement).toMatchObject({ visible: true, parentIsShell: true })
      await expect(gen.getByTestId('gen-unsaved')).toContainText('draft.md')
      await expect(gen.getByTestId('gen-make')).toBeDisabled()
      await expect(gen.locator('[data-problem="missing"]')).toContainText('gone.docx')
      await expect(gen.locator('[data-problem="unsupported"]')).toContainText('clip.mp4')
      await gen.screenshot({ path: shot('generate-window-unsaved') })
      if (EVIDENCE_DIR && process.platform === 'win32' && placement.parent) {
        // the whole screen area of the shell window: the editor with the window over it
        const { x, y, width, height } = placement.parent
        const script = join(dir, 'grab.ps1')
        await writeFile(
          script,
          [
            'Add-Type -AssemblyName System.Drawing',
            `$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})`,
            '$g = [System.Drawing.Graphics]::FromImage($bmp)',
            `$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)`,
            `$bmp.Save('${shot('generate-window-over-editor').replace(/'/g, "''")}')`,
          ].join('\n'),
        )
        await gen.bringToFront()
        await new Promise((r) => setTimeout(r, 500))
        execFileSync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ])
      }

      // its save button saves the tab in place; then "make" can be pressed
      await gen.getByTestId('gen-unsaved').getByTestId('gen-save-material').click()
      await expect(gen.getByTestId('gen-unsaved')).toHaveCount(0, { timeout: 15_000 })
      await expect(gen.locator('li[data-name="draft.md"]')).toHaveAttribute('data-state', 'ready')
      await expect(gen.getByTestId('gen-make')).toBeEnabled()
      expect(await readFile(draft, 'utf8')).toContain('an unsaved edit')

      // ── 5. "make": a new mind map tab with the request queued for it only ──
      expect(await handoffs()).toEqual({ queued: [], taken: 0 })
      await gen.locator('[data-kind="mindmap"]').click()
      await gen.locator('#gen-request').fill('Focus on the plan')
      await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.aiOfficeTabs.list())).find((t) => t.active)?.kind,
        )
        .toBe('mindmap')
      const mindmapWebContents = () =>
        app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((wc) => wc.getURL().includes('://mindmap/'))
            .map((wc) => wc.id),
        )
      // the new view commits its URL a moment after the tab shows
      await expect.poll(async () => (await mindmapWebContents()).length).toBe(1)
      const mindmapIds = await mindmapWebContents()
      // queued for that tab only, unless its editor has already taken it
      const queued = await handoffs()
      if (queued.taken === 0) {
        expect(queued.queued).toEqual([
          {
            webContentsId: mindmapIds[0],
            target: 'mindmap',
            materials: [draft, lesson],
            text: 'Focus on the plan',
          },
        ])
      }
      // the mind map editor in that tab takes it; with nothing signed in the send
      // gate blocks the run, so no stream is ever asked for
      await expect.poll(handoffs, { timeout: 30_000 }).toEqual({ queued: [], taken: 1 })
      await new Promise((r) => setTimeout(r, 3000))
      expect(
        await app.evaluate(() => (globalThis as Record<string, unknown>).__generateE2eStreams),
      ).toBe(0)
      await page.screenshot({ path: shot('generate-new-mindmap-tab') })

      // closing the tab drops what it took
      const tabs = await page.evaluate(() => window.aiOfficeTabs.list())
      const mapTab = tabs.find((t) => t.kind === 'mindmap')!
      await page.evaluate((id) => window.aiOfficeTabs.close(id), mapTab.id)
      await expect.poll(handoffs).toEqual({ queued: [], taken: 0 })
    } finally {
      await closeAndSaveVideo(launched, 'generate-window')
    }
  })
})
