import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

/**
 * Split view (decision 0036): two panes of one shell window, the AI panel
 * following the focused pane, same-document copies, the save guard between
 * copies, and the restored arrangement on the next launch.
 *
 * The drag is driven through the renderer-facing tab API (`window.aiOfficeTabs`)
 * exactly like tab-tear-off-dock.spec.ts — Playwright cannot hold an OS-level
 * drag. The divider's own mouse drag and the native tab menu are covered by
 * unit tests (apps/shell/tests/split-renderer.test.ts, split-wiring.test.ts).
 *
 * Hands-on checklist (unit tests cover the logic; the built app was not
 * exercised for these in this run):
 *   - a running AI execution survives a pane losing focus (docs
 *     ai-panel-collapse.test.ts pins the collapse keeps mounts alive),
 *   - a slideshow entering fullscreen covers the window and restores the split,
 *   - autosave defers silently instead of prompting (each app's
 *     save-conflict test covers the branch).
 */

interface SplitState {
  aTabId: string
  bTabId: string
  orientation: 'side' | 'stack'
  ratio: number
  focus: 'a' | 'b'
}

interface TabSummaryLike {
  id: string
  kind: string
  title: string
  active: boolean
  filePath?: string
}

interface TabsApiOnWindow {
  aiOfficeTabs: {
    list(): Promise<TabSummaryLike[]>
    getSplit(): Promise<SplitState | null>
    setSplitRatio(ratio: number): void
    tearOff(id: string, screenX: number, screenY: number): Promise<boolean>
    dragTornWindow(screenX: number, screenY: number): void
    endTornDrag(): Promise<void>
    close(id: string): Promise<void>
  }
  aiOffice: { openPath(path: string): Promise<void> }
}

const tabsApi = (page: Page) =>
  page.evaluate(() => (window as unknown as TabsApiOnWindow).aiOfficeTabs.list())
const splitState = (page: Page) =>
  page.evaluate(() => (window as unknown as TabsApiOnWindow).aiOfficeTabs.getSplit())

async function contentBounds(
  app: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds())
}

/** visible markdown views of the shell window, with their rectangles */
async function markdownViews(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win.contentView.children
      .filter(
        (child): child is Electron.WebContentsView =>
          child instanceof WebContentsView && child.webContents.getURL().includes('://markdown/'),
      )
      .map((view) => ({
        visible: view.getVisible(),
        bounds: view.getBounds(),
        url: view.webContents.getURL(),
      }))
  })
}

async function roleOf(page: Page): Promise<'focus' | 'secondary' | null> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as { aiOfficeSplit?: { getRole(): Promise<'focus' | 'secondary' | null> } }
    ).aiOfficeSplit
    if (!api) return null
    return api.getRole()
  })
}

async function markdownPages(app: ElectronApplication): Promise<Page[]> {
  const pages: Page[] = []
  for (const page of app.windows()) {
    // page.url() can be empty or about:blank when the attach raced navigation
    const href = await page.evaluate(() => window.location.href).catch(() => '')
    if (href.includes('://markdown/')) pages.push(page)
  }
  return pages
}

/** tear `tabId` off and drop it on the right (`side`) or bottom (`stack`) edge */
async function dropTabOnEdge(
  app: ElectronApplication,
  shell: Page,
  tabId: string,
  edge: 'side' | 'stack',
): Promise<void> {
  const bounds = await contentBounds(app)
  const target =
    edge === 'side'
      ? { x: bounds.x + bounds.width - 8, y: bounds.y + Math.round(bounds.height / 2) }
      : { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + bounds.height - 8 }
  const torn = await shell.evaluate(
    (id) => (window as unknown as TabsApiOnWindow).aiOfficeTabs.tearOff(id, 500, 400),
    tabId,
  )
  expect(torn, 'the tab was torn off').toBe(true)
  // A real drag emits a stream of pointer moves, so one lost hint message is
  // repaired by the next. This test sends a handful of synthetic moves instead,
  // and main de-duplicates a repeated hint, so a single message that the shell
  // renderer misses would never be resent. Step out of the zone (clears the
  // hint) and back in before each retry, like a hand wobbling over the edge.
  const middle = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  }
  const moveTornWindow = (p: { x: number; y: number }) =>
    shell.evaluate(
      (q) => (window as unknown as TabsApiOnWindow).aiOfficeTabs.dragTornWindow(q.x, q.y),
      p,
    )
  await moveTornWindow(target)
  // the hint lives inside the strip (panes are covered by their views)
  await expect(async () => {
    if ((await shell.locator('.tab-split-hint').count()) === 0) {
      await moveTornWindow(middle)
      await moveTornWindow(target)
    }
    await expect(shell.locator('.tab-split-hint')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  await shell.evaluate(() => (window as unknown as TabsApiOnWindow).aiOfficeTabs.endTornDrag())
}

/** place the caret at the end of the markdown document and type `text` */
async function appendToMarkdown(page: Page, text: string): Promise<void> {
  const editor = page.locator('.doc-editor')
  await editor.click()
  await expect
    .poll(async () => {
      await editor.evaluate((element) => {
        const last = element.lastElementChild
        const selection = window.getSelection()
        if (!last || !selection) throw new Error('markdown editor has no final block')
        const range = document.createRange()
        range.selectNodeContents(last)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      })
      await page.waitForTimeout(150)
      return editor.evaluate((element) => {
        const selection = window.getSelection()
        const last = element.lastElementChild
        return Boolean(
          selection?.isCollapsed && selection.anchorNode && last?.contains(selection.anchorNode),
        )
      })
    })
    .toBe(true)
  await page.keyboard.type(text)
}

test.describe('split view', () => {
  test('two documents split side by side; roles follow the focused pane', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-split-'))
    const aPath = join(dir, 'alpha.md')
    const bPath = join(dir, 'beta.md')
    await writeFile(aPath, '# Alpha\n\nfirst document.\n')
    await writeFile(bPath, '# Beta\n\nsecond document.\n')

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'split-view-basic',
      openFiles: [aPath, bPath],
    })
    const { app } = launched
    try {
      const shell = await waitForPageWithUrl(app, 'shell/out')
      const tabs = await tabsApi(shell)
      const alpha = tabs.find((t) => t.title === 'alpha.md')
      const beta = tabs.find((t) => t.title === 'beta.md')
      expect(alpha, 'alpha.md opened').toBeTruthy()
      expect(beta, 'beta.md opened').toBeTruthy()

      await dropTabOnEdge(app, shell, beta!.id, 'side')
      await expect(shell.locator('.tab-split-hint')).toHaveCount(0)

      const split = await splitState(shell)
      expect(split, 'the drop created a split').not.toBeNull()
      expect(split!.orientation).toBe('side')
      expect(split!.aTabId).toBe(alpha!.id)
      expect(split!.focus).toBe('b')
      // the dropped side is a fresh tab of beta.md (the torn id is gone)
      const after = await tabsApi(shell)
      expect(after.some((t) => t.id === beta!.id)).toBe(false)
      const betaAgain = after.find((t) => t.title === 'beta.md' && t.id === split!.bTabId)
      expect(betaAgain, 'the dropped tab came back under a new id').toBeTruthy()
      // both pane tabs carry a strip marker
      await expect(shell.locator('.tab-item.split-a, .tab-item.split-b').first()).toBeVisible()

      // two visible panes, side by side, gap between them
      await expect
        .poll(async () => {
          const views = await markdownViews(app)
          return views.filter((v) => v.visible).length
        })
        .toBe(2)
      const [left, right] = (await markdownViews(app))
        .filter((v) => v.visible)
        .sort((v1, v2) => v1.bounds.x - v2.bounds.x)
      expect(left.bounds.x).toBe(0)
      expect(right.bounds.x).toBeGreaterThanOrEqual(left.bounds.width + 6)
      expect(right.bounds.y).toBe(left.bounds.y)

      // roles: exactly one focus and one secondary among the pane pages
      await expect
        .poll(async () => {
          const roles = await Promise.all((await markdownPages(app)).map(roleOf))
          return roles.sort().join(',')
        })
        .toBe('focus,secondary')

      // clicking the secondary pane focuses it and moves the role with it
      const pages = await markdownPages(app)
      const secondary = (
        await Promise.all(pages.map(async (p) => ({ p, role: await roleOf(p) })))
      ).find((entry) => entry.role === 'secondary')!.p
      await secondary.locator('.doc-editor').click()
      // Playwright's synthetic input does not hand native keyboard focus to a
      // WebContentsView the way a real click does; nudge the left pane's
      // webContents exactly as clicking it would, and let the focus event (or
      // the renderer fallback ping) drive the pane switch.
      await app.evaluate(({ BrowserWindow, WebContentsView }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const left = win.contentView.children.find(
          (child): child is Electron.WebContentsView =>
            child instanceof WebContentsView &&
            child.getVisible() &&
            child.getBounds().x === 0 &&
            child.webContents.getURL().includes('://markdown/'),
        )
        left?.webContents.focus()
      })
      await expect.poll(async () => roleOf(secondary)).toBe('focus')
      await expect.poll(async () => (await splitState(shell))?.focus).toBe('a')
      await expect
        .poll(async () => {
          const roles = await Promise.all((await markdownPages(app)).map(roleOf))
          return roles.sort().join(',')
        })
        .toBe('focus,secondary')
    } finally {
      await closeAndSaveVideo(launched, 'split-view-basic')
    }
  })

  test('splitting the only document makes a same-document copy; the divider closes a side', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-split-'))
    const aPath = join(dir, 'solo.md')
    await writeFile(aPath, '# Solo\n\none document.\n')

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'split-view-copy',
      openFile: aPath,
    })
    const { app } = launched
    try {
      const shell = await waitForPageWithUrl(app, 'shell/out')
      const tabs = await tabsApi(shell)
      const solo = tabs.find((t) => t.title === 'solo.md')
      expect(solo, 'solo.md opened').toBeTruthy()

      await dropTabOnEdge(app, shell, solo!.id, 'side')
      const split = await splitState(shell)
      expect(split, 'the lone document split into a copy').not.toBeNull()
      expect(split!.aTabId).not.toBe(split!.bTabId)
      const after = await tabsApi(shell)
      const copies = after.filter((t) => t.title === 'solo.md')
      expect(copies).toHaveLength(2)
      await expect
        .poll(async () => (await markdownViews(app)).filter((v) => v.visible).length)
        .toBe(2)

      // divider: an in-between drag resizes, the far end closes the b side
      const bounds = await contentBounds(app)
      await shell.evaluate(() =>
        (window as unknown as TabsApiOnWindow).aiOfficeTabs.setSplitRatio(0.7),
      )
      await expect
        .poll(async () => {
          const [left] = (await markdownViews(app))
            .filter((v) => v.visible)
            .sort((v1, v2) => v1.bounds.x - v2.bounds.x)
          return left ? Math.round(left.bounds.width) : 0
        })
        .toBeGreaterThan(Math.round((bounds.width - 6) * 0.6))
      await shell.evaluate(() =>
        (window as unknown as TabsApiOnWindow).aiOfficeTabs.setSplitRatio(1),
      )
      await expect.poll(async () => splitState(shell)).toBeNull()
      // the closed side returns to the strip; the survivor fills the window
      await expect.poll(async () => (await tabsApi(shell)).length).toBe(3)
      const views = (await markdownViews(app)).filter((v) => v.visible)
      expect(views).toHaveLength(1)
      expect(views[0].bounds.width).toBe(bounds.width)
    } finally {
      await closeAndSaveVideo(launched, 'split-view-copy')
    }
  })

  test('a strip tab replaces the focused pane; Home covers the split and restores it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-split-'))
    const aPath = join(dir, 'one.md')
    const bPath = join(dir, 'two.md')
    const cPath = join(dir, 'three.md')
    await writeFile(aPath, '# One\n')
    await writeFile(bPath, '# Two\n')
    await writeFile(cPath, '# Three\n')

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'split-view-replace',
      openFiles: [aPath, bPath],
    })
    const { app } = launched
    try {
      const shell = await waitForPageWithUrl(app, 'shell/out')
      const tabs = await tabsApi(shell)
      const a = tabs.find((t) => t.title === 'one.md')!
      const b = tabs.find((t) => t.title === 'two.md')!
      await dropTabOnEdge(app, shell, b.id, 'side')
      const split = (await splitState(shell))!
      expect(split.focus).toBe('b')

      // opening a third document while split goes into the focused pane
      await shell.evaluate(
        (p) => (window as unknown as TabsApiOnWindow).aiOffice.openPath(p),
        cPath,
      )
      await expect
        .poll(async () => {
          const state = await splitState(shell)
          if (!state) return null
          const list = await tabsApi(shell)
          return list.find((t) => t.id === state.bTabId)?.title ?? null
        })
        .toBe('three.md')
      const replaced = (await splitState(shell))!
      expect(replaced.aTabId).toBe(a.id)
      expect(replaced.focus).toBe('b')

      // Home covers both panes without clearing the split
      await shell.locator('.tab-item.tab-home').click()
      await expect
        .poll(async () => (await markdownViews(app)).filter((v) => v.visible).length)
        .toBe(0)
      expect(await splitState(shell)).not.toBeNull()

      // returning to a pane tab brings the arrangement back
      await shell.locator('.tab-item', { hasText: 'one.md' }).click()
      await expect
        .poll(async () => (await markdownViews(app)).filter((v) => v.visible).length)
        .toBe(2)
      const back = (await splitState(shell))!
      expect(back.aTabId).toBe(a.id)
      expect(back.bTabId).toBe(replaced.bTabId)
    } finally {
      await closeAndSaveVideo(launched, 'split-view-replace')
    }
  })

  test('restores the split arrangement on the next launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-split-'))
    const aPath = join(dir, 'restore-a.md')
    const bPath = join(dir, 'restore-b.md')
    await writeFile(aPath, '# Restore A\n')
    await writeFile(bPath, '# Restore B\n')

    const first = await launchShell({
      onboardingSeen: true,
      videoDir: 'split-view-restore-1',
      openFiles: [aPath, bPath],
    })
    let userDataDir: string
    try {
      const shell = await waitForPageWithUrl(first.app, 'shell/out')
      const tabs = await tabsApi(shell)
      const b = tabs.find((t) => t.title === 'restore-b.md')!
      await dropTabOnEdge(first.app, shell, b.id, 'side')
      await expect.poll(async () => splitState(shell)).not.toBeNull()
      userDataDir = first.userDataDir
    } finally {
      await closeAndSaveVideo(first, 'split-view-restore-1')
    }

    const second = await launchShell({
      userDataDir,
      videoDir: 'split-view-restore-2',
    })
    try {
      const shell = await waitForPageWithUrl(second.app, 'shell/out')
      await expect.poll(async () => splitState(shell)).not.toBeNull()
      const state = (await splitState(shell))!
      expect(state.orientation).toBe('side')
      const list = await tabsApi(shell)
      const titles = [state.aTabId, state.bTabId].map(
        (id) => list.find((t) => t.id === id)?.title ?? null,
      )
      expect(titles.sort()).toEqual(['restore-a.md', 'restore-b.md'])
      await expect
        .poll(async () => (await markdownViews(second.app)).filter((v) => v.visible).length)
        .toBe(2)
    } finally {
      await closeAndSaveVideo(second, 'split-view-restore-2')
    }
  })

  test('the second save across same-document copies asks before overwriting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-split-'))
    const soloPath = join(dir, 'guard.md')
    await writeFile(soloPath, '# Guard\n\nbase.\n')

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'split-view-save-guard',
      openFile: soloPath,
    })
    const { app } = launched
    try {
      const shell = await waitForPageWithUrl(app, 'shell/out')
      const tabs = await tabsApi(shell)
      const solo = tabs.find((t) => t.title === 'guard.md')!
      await dropTabOnEdge(app, shell, solo.id, 'side')

      // the re-attached pane needs a moment to mount queryable roles
      let focusPane: Page | undefined
      let otherPane: Page | undefined
      await expect
        .poll(async () => {
          const entries = await Promise.all(
            (await markdownPages(app)).map(async (p) => ({ p, role: await roleOf(p) })),
          )
          focusPane = entries.find((entry) => entry.role === 'focus')?.p
          otherPane = entries.find((entry) => entry.role === 'secondary')?.p
          return focusPane !== undefined && otherPane !== undefined
        })
        .toBe(true)

      // first copy saves a marker: the disk now differs from the other copy's read
      await appendToMarkdown(focusPane, 'FIRST-COPY-MARKER')
      await focusPane.keyboard.press('ControlOrMeta+s')
      await expect
        .poll(async () => (await readFile(soloPath, 'utf8')).includes('FIRST-COPY-MARKER'))
        .toBe(true)

      // the other copy's save must stop at the overwrite prompt; answer Cancel
      await app.evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __splitGuardAsks: number }
        g.__splitGuardAsks = 0
        dialog.showMessageBox = (async () => {
          g.__splitGuardAsks += 1
          return { response: 1, checkboxChecked: false }
        }) as typeof dialog.showMessageBox
      })
      await appendToMarkdown(otherPane, 'SECOND-COPY-MARKER')
      await otherPane.keyboard.press('ControlOrMeta+s')
      await expect
        .poll(() =>
          app.evaluate(
            () => (globalThis as unknown as { __splitGuardAsks: number }).__splitGuardAsks,
          ),
        )
        .toBeGreaterThan(0)
      // the canceled save did not touch the file
      const onDisk = await readFile(soloPath, 'utf8')
      expect(onDisk).toContain('FIRST-COPY-MARKER')
      expect(onDisk).not.toContain('SECOND-COPY-MARKER')
    } finally {
      await closeAndSaveVideo(launched, 'split-view-save-guard')
    }
  })
})
