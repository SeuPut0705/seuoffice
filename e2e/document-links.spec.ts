import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createXmindDocumentFromOutline } from '@genoffice/xmind-engine'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

/**
 * Provenance records (spec 9) and the File-menu entry "make another document
 * from this one" (8.2), on the built app: a map converted to markdown and
 * saved leaves one record in the app data folder (and nothing in either
 * file); the markdown tab's File menu shows "View Sources" with the map, the
 * map's shows "Documents Made from This"; renaming the made document in the
 * app moves the record; a source that is gone from disk is dimmed and its
 * record stays; the entry opens the make window with the open document from
 * the mind map (menu and toolbar) and from an editor that builds its own menu.
 *
 * Nothing here reaches Claude or Codex: a conversion runs no AI, and on top of
 * that the subscription status handlers answer "not installed", the real
 * status pushes are kept from the tabs, and `ai:stream` is a recording stub the
 * test asserts was never called.
 */

const EVIDENCE_DIR = process.env.DOCUMENT_LINKS_EVIDENCE_DIR
const shot = (name: string) =>
  EVIDENCE_DIR ? join(EVIDENCE_DIR, `${name}.png`) : screenshotPath(name)

interface ShellWindow {
  aiOffice: {
    openPath(path: string): Promise<void>
    renameFile(path: string, newName: string): Promise<{ ok: boolean; path?: string }>
  }
  aiOfficeGenerate: { openWithPaths(paths: string[]): Promise<void> }
  aiOfficeTabs: {
    list(): Promise<Array<{ id: string; kind: string; active: boolean; filePath?: string }>>
    activate(id: string): Promise<void>
  }
}

interface MenuEntry {
  id?: string
  label: string
  enabled: boolean
  sublabel?: string
  submenu?: MenuEntry[]
}

async function stubAi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, webContents }) => {
    const g = globalThis as Record<string, unknown>
    g.__linksE2eStreams = 0
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
      g.__linksE2eStreams = (g.__linksE2eStreams as number) + 1
      throw new Error('ai:stream is stubbed in this test')
    })
  })
}

/** the application menu's File menu as plain data */
const fileMenu = (app: ElectronApplication) =>
  app.evaluate(({ Menu }): MenuEntry[] => {
    const plain = (items: Electron.MenuItem[]): MenuEntry[] =>
      items.map((i) => ({
        ...(i.id ? { id: i.id } : {}),
        label: i.type === 'separator' ? '---' : i.label,
        enabled: i.enabled,
        ...(i.sublabel ? { sublabel: i.sublabel } : {}),
        ...(i.submenu ? { submenu: plain(i.submenu.items) } : {}),
      }))
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
    return file?.submenu ? plain(file.submenu.items) : []
  })

/** press a File-menu item by id, or by label */
const pressFileItem = (app: ElectronApplication, key: { id?: string; label?: string }) =>
  app.evaluate(({ Menu }, k) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
    const item = file?.submenu?.items.find((i) => (k.id ? i.id === k.id : i.label === k.label))
    if (!item) throw new Error(`no File-menu item ${k.id ?? k.label}`)
    item.click()
  }, key)

const listTabs = (page: Page) =>
  page.evaluate(() => (window as unknown as ShellWindow).aiOfficeTabs.list())
const activeTab = async (page: Page) => (await listTabs(page)).find((t) => t.active)

async function newestPage(app: ElectronApplication, urlPart: string): Promise<Page> {
  await waitForPageWithUrl(app, urlPart)
  const pages = app.windows().filter((w) => w.url().includes(urlPart))
  return pages[pages.length - 1]!
}

async function generatePage(app: ElectronApplication): Promise<Page> {
  const page = await waitForPageWithUrl(app, 'generate.html')
  await expect(page.getByTestId('generate-window')).toBeVisible()
  return page
}

async function cancel(gen: Page): Promise<void> {
  const closed = gen.waitForEvent('close')
  // the window can close before the click itself has finished: that is the button working
  await gen
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
    .catch((err: unknown) => {
      if (!gen.isClosed()) throw err
    })
  await closed
}

const OUTLINE = ['# Plan', '', '- Trip', '  - Day one', '  - Day two', ''].join('\n')

test.describe('provenance records', () => {
  test('convert, save, menus, rename, missing source, make from this', async () => {
    test.setTimeout(300_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-links-e2e-'))
    const saveDir = join(dir, 'saved')
    await mkdir(saveDir)
    const map = join(dir, 'plan.xmind')
    const mapBytes = await (await createXmindDocumentFromOutline(OUTLINE, { untitled: 'U' })).save()
    await writeFile(map, mapBytes)
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({
      onboardingSeen: true,
      settings: { defaultSaveDir: saveDir },
      videoDir: 'document-links',
    })
    const { app, page, userDataDir } = launched
    await stubAi(app)
    const linksFile = join(userDataDir, 'document-links.json')
    const records = async () =>
      existsSync(linksFile)
        ? (JSON.parse(await readFile(linksFile, 'utf8')) as {
            version: number
            links: Array<{ derived: string; sources: string[]; createdAt: string; via: string }>
          })
        : null
    const evidence: Record<string, unknown> = {}
    try {
      // ── convert the map to markdown: a new unsaved tab, no record yet ──
      await page.evaluate(
        (p) => (window as unknown as ShellWindow).aiOfficeGenerate.openWithPaths(p),
        [map],
      )
      let gen = await generatePage(app)
      await gen.getByTestId('gen-convert').locator('[data-convert="mindmap-to-markdown"]').click()
      await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('markdown')
      const md = await newestPage(app, '://markdown/')
      await expect(md.locator('.doc-editor h1').first()).toHaveText('Plan')
      expect(await records()).toBeNull()
      const mdTabId = (await activeTab(page))!.id

      // an unsaved document's File menu has the make entry only
      let menu = await fileMenu(app)
      expect(menu.map((i) => i.id).filter(Boolean)).toEqual(['document-links-make'])

      // ── first save: the record lands in the app data folder ──
      const target = join(saveDir, 'plan-notes.md')
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as never
      }, target)
      await pressFileItem(app, { label: 'Save' })
      await expect.poll(async () => (await activeTab(page))?.filePath).toBeTruthy()
      const derived = (await activeTab(page))!.filePath!
      await expect.poll(async () => (await records())?.links.length ?? 0).toBe(1)
      const saved = (await records())!
      expect(saved.version).toBe(1)
      expect(saved.links[0]).toEqual({
        derived,
        sources: [map],
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        via: 'convert',
      })
      evidence.recordAfterSave = saved
      // nothing written into either document
      expect(Buffer.from(await readFile(map)).equals(Buffer.from(mapBytes))).toBe(true)
      expect(await readFile(derived, 'utf8')).not.toMatch(/plan\.xmind|document-links/)

      // the markdown tab's File menu: "View Sources" with the map
      await expect
        .poll(async () => (await fileMenu(app)).some((i) => i.id === 'document-links-sources'))
        .toBe(true)
      menu = await fileMenu(app)
      evidence.markdownMenu = menu
      const sources = menu.find((i) => i.id === 'document-links-sources')!
      expect(sources.label).toBe('View Sources')
      expect(sources.submenu?.map((e) => [e.label, e.enabled])).toEqual([['plan.xmind', true]])
      expect(menu.find((i) => i.id === 'document-links-derived')).toBeUndefined()

      // ── the map's File menu: "Documents Made from This" ──
      await page.evaluate((p) => (window as unknown as ShellWindow).aiOffice.openPath(p), map)
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('mindmap')
      const mm = await newestPage(app, '://mindmap/')
      await expect(mm.locator('me-tpc').first()).toBeVisible({ timeout: 30_000 })
      menu = await fileMenu(app)
      evidence.mapMenu = menu
      const made = menu.find((i) => i.id === 'document-links-derived')!
      expect(made.label).toBe('Documents Made from This')
      expect(made.submenu?.map((e) => e.label)).toEqual([basename(derived)])
      expect(menu.find((i) => i.id === 'document-links-sources')).toBeUndefined()

      // ── rename the made document in the app: the record follows ──
      const renamed = await page.evaluate(
        (p) => (window as unknown as ShellWindow).aiOffice.renameFile(p, 'renamed-notes.md'),
        derived,
      )
      expect(renamed.ok).toBe(true)
      const renamedPath = join(saveDir, 'renamed-notes.md')
      await expect.poll(async () => (await records())?.links[0]?.derived).toBe(renamedPath)
      evidence.recordAfterRename = await records()
      await expect
        .poll(async () =>
          (await fileMenu(app))
            .find((i) => i.id === 'document-links-derived')
            ?.submenu?.map((e) => e.label),
        )
        .toEqual(['renamed-notes.md'])

      // ── "make another document from this one" from the map's File menu ──
      await pressFileItem(app, { id: 'document-links-make' })
      gen = await generatePage(app)
      await expect(gen.locator('li[data-state="ready"]')).toHaveCount(1)
      await expect(gen.locator('li[data-state="ready"]')).toHaveAttribute('data-name', 'plan.xmind')
      await gen.screenshot({ path: shot('make-from-map-menu') })
      await cancel(gen)

      // ── the same from the map's toolbar button ──
      await mm.locator('[data-action="make-from-document"]').click()
      gen = await generatePage(app)
      await expect(gen.locator('li[data-state="ready"]')).toHaveAttribute('data-name', 'plan.xmind')
      await mm.screenshot({ path: shot('mindmap-toolbar') })
      await cancel(gen)

      // ── an editor with its own menu (docs): the make window lists the unsaved document ──
      await page.evaluate(() => (window as unknown as ShellWindow).aiOfficeTabs.activate('home'))
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('home')
      await pressFileItem(app, { label: 'AI Docs' })
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('docs')
      await waitForPageWithUrl(app, '://docs/')
      await expect
        .poll(async () => (await fileMenu(app)).some((i) => i.id === 'document-links-make'))
        .toBe(true)
      menu = await fileMenu(app)
      evidence.docsMenu = menu
      expect(menu.find((i) => i.id === 'document-links-sources')).toBeUndefined()
      await pressFileItem(app, { id: 'document-links-make' })
      gen = await generatePage(app)
      await expect(gen.getByTestId('generate-window')).toContainText(
        'This document was never saved. Save it first to use it.',
      )
      await gen.screenshot({ path: shot('make-from-docs-menu') })
      await cancel(gen)

      // ── the source is gone from disk: dimmed, not clickable, record kept ──
      await rm(map)
      await page.evaluate(
        (id) => (window as unknown as ShellWindow).aiOfficeTabs.activate(id),
        mdTabId,
      )
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('markdown')
      menu = await fileMenu(app)
      evidence.markdownMenuSourceGone = menu
      expect(
        menu
          .find((i) => i.id === 'document-links-sources')
          ?.submenu?.map((e) => [e.label, e.enabled]),
      ).toEqual([['plan.xmind', false]])
      const kept = (await records())!
      expect(kept.links).toEqual([
        {
          derived: renamedPath,
          sources: [map],
          createdAt: saved.links[0]!.createdAt,
          via: 'convert',
        },
      ])

      // ── no AI anywhere ──
      expect(
        await app.evaluate(() => (globalThis as Record<string, unknown>).__linksE2eStreams),
      ).toBe(0)
    } finally {
      if (EVIDENCE_DIR)
        await writeFile(
          join(EVIDENCE_DIR, 'document-links-e2e.json'),
          JSON.stringify(evidence, null, 2),
        )
      await closeAndSaveVideo(launched, 'document-links')
    }
  })
})
