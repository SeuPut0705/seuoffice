import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createXmindDocumentFromOutline } from '@genoffice/xmind-engine'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

/**
 * "Convert without AI" (spec 8.6) from the make window, on the built app: the
 * option shows only for one material of a matching type; each of the three
 * conversions opens a new, unsaved tab with the expected content; a markdown
 * source with withheld spans shows the notice first and its result carries
 * the labels, never the hidden words; the shell records each conversion with
 * its source and the new tab.
 *
 * Nothing here reaches Claude or Codex: a conversion runs no AI, and on top of
 * that the main process's subscription status handlers answer "not
 * installed", the real status pushes are kept from the tabs, and `ai:stream`
 * is a recording stub that the test asserts was never called.
 */

/** where the screenshots for review go (defaults to e2e/artifacts/screenshots) */
const EVIDENCE_DIR = process.env.GENERATE_EVIDENCE_DIR
const shot = (name: string) =>
  EVIDENCE_DIR ? join(EVIDENCE_DIR, `${name}.png`) : screenshotPath(name)

interface ShellWindow {
  aiOfficeGenerate: { openWithPaths(paths: string[]): Promise<void> }
  aiOfficeTabs: {
    list(): Promise<Array<{ id: string; kind: string; active: boolean; filePath?: string }>>
  }
}

interface ConvertedEvent {
  tabId?: string
  webContentsId: number
  target: string
  kind: string
  mode: string
  sources: string[]
}

/** the AI channels in the main process become stubs: nothing is signed in, and a stream is recorded, never run */
async function stubAi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, webContents }) => {
    const g = globalThis as Record<string, unknown>
    g.__convertE2eStreams = 0
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
      g.__convertE2eStreams = (g.__convertE2eStreams as number) + 1
      throw new Error('ai:stream is stubbed in this test')
    })
  })
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

const listTabs = (page: Page) =>
  page.evaluate(() => (window as unknown as ShellWindow).aiOfficeTabs.list())

async function activeTab(page: Page) {
  return (await listTabs(page)).find((t) => t.active)
}

/** the editor page behind the newest webContents with this URL part */
async function newestPage(app: ElectronApplication, urlPart: string): Promise<Page> {
  await waitForPageWithUrl(app, urlPart)
  const pages = app.windows().filter((w) => w.url().includes(urlPart))
  return pages[pages.length - 1]!
}

const convertedEvents = (app: ElectronApplication) =>
  app.evaluate((): ConvertedEvent[] => {
    const store = (globalThis as Record<symbol, unknown>)[
      Symbol.for('genoffice.generate-handoff')
    ] as { converted?: ConvertedEvent[] } | undefined
    return (store?.converted ?? []).map((e) => ({
      ...(e.tabId ? { tabId: e.tabId } : {}),
      webContentsId: e.webContentsId,
      target: e.target,
      kind: e.kind,
      mode: e.mode,
      sources: [...e.sources],
    }))
  })

const MAP_OUTLINE = [
  '# Plan',
  '',
  '- Trip',
  '  - Day one [easy] <https://example.com/a>',
  '    > bring water',
  '    - Museum',
  '      - Lunch',
  '    - Park',
  '  - Day two',
  '    - Beach',
  '',
  '# Second sheet',
  '',
  '- Elsewhere',
  '  - Not on the slides',
  '',
].join('\n')

const span = (label: string, words: string) =>
  `<span class="redact-span" data-redaction="" data-label="${label}">${words}</span>`

test.describe('convert without AI', () => {
  test('map → markdown, map → PPT, markdown → map: each opens a new unsaved tab', async () => {
    test.setTimeout(300_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-convert-e2e-'))
    const map = join(dir, 'plan.xmind')
    const notes = join(dir, 'lesson.md')
    const brief = join(dir, 'brief.docx')
    const doc = await createXmindDocumentFromOutline(MAP_OUTLINE, { untitled: 'Untitled' })
    await writeFile(map, await doc.save())
    await writeFile(
      notes,
      [
        '# Lesson',
        '',
        '## Warm-up',
        '',
        'A paragraph about the warm-up.',
        '',
        `- Ask ${span('Name', 'Kim Minji')} first`,
        '- Then the class',
        '',
        '## Main',
        '',
      ].join('\n'),
    )
    await writeFile(brief, 'not really a docx')
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'generate-convert' })
    const { app, page } = launched
    await stubAi(app)
    const open = (paths: string[]) =>
      page.evaluate(
        (p) => (window as unknown as ShellWindow).aiOfficeGenerate.openWithPaths(p),
        paths,
      )
    try {
      // ── the option shows only for one material of a matching type ──
      await open([map, notes])
      let gen = await generatePage(app)
      await expect(gen.locator('li[data-state="ready"]')).toHaveCount(2)
      await expect(gen.getByTestId('gen-convert')).toHaveCount(0)
      await cancel(gen)

      // ── 1. map → markdown ──
      await open([map])
      gen = await generatePage(app)
      await expect(gen.locator('li[data-state="ready"]')).toHaveCount(1)
      const convert = gen.getByTestId('gen-convert')
      await expect(convert).toBeVisible()
      await expect(convert.locator('[data-convert]')).toHaveCount(2)
      await convert.locator('[data-convert="mindmap-to-markdown"]').click()
      await expect(convert.locator('[data-convert="mindmap-to-markdown"]')).toHaveAttribute(
        'aria-checked',
        'true',
      )
      // no request text for a conversion, no AI notices, no redaction notice for a map
      await expect(gen.locator('#gen-request')).toBeHidden()
      await expect(gen.getByTestId('gen-redaction-notice')).toHaveCount(0)
      await expect(gen.getByTestId('gen-make')).toBeEnabled()
      await gen.screenshot({ path: shot('convert-window-map') })
      await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('markdown')
      const md = await newestPage(app, '://markdown/')
      await expect(md.locator('.doc-editor h1').first()).toHaveText('Plan')
      await expect(md.locator('.doc-editor')).toContainText('Day one')
      await expect(md.locator('.doc-editor')).toContainText('bring water')
      await expect(md.locator('.doc-editor')).toContainText('Second sheet')
      await expect(md.locator('.status-save')).toHaveText('Unsaved')
      expect((await activeTab(page))?.filePath).toBeUndefined()
      await md.screenshot({ path: shot('convert-result-markdown') })

      // ── 2. map → PPT skeleton ──
      await open([map])
      gen = await generatePage(app)
      await gen.getByTestId('gen-convert').locator('[data-convert="mindmap-to-slides"]').click()
      await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('slides')
      const slides = await newestPage(app, '://slides/')
      await expect(slides.locator('.stage-wrap canvas').first()).toBeVisible({ timeout: 30_000 })
      // the session as the tab holds it (asking again only restores it; nothing is taken twice)
      const deck = await slides.evaluate(async () => {
        interface Line {
          level?: number
          runs: Array<{ text: string; isBullet?: boolean }>
        }
        interface Slide {
          nodes: Array<{ text?: { lines: Line[] } }>
        }
        const api = (
          window as unknown as {
            slidesApi: {
              consumePendingOpen(fit: number): Promise<{ path: string; slides: Slide[] } | null>
              isDirty(): Promise<boolean>
            }
          }
        ).slidesApi
        const r = await api.consumePendingOpen(1280)
        // each line as "<level>:<text>", bullets marked with "- "
        const lines = (r?.slides ?? []).map((s) =>
          s.nodes.flatMap((n) =>
            (n.text?.lines ?? []).map((l) => {
              const bullet = l.runs.some((run) => run.isBullet) ? '- ' : ''
              const text = l.runs
                .filter((run) => !run.isBullet)
                .map((run) => run.text)
                .join('')
              return `${l.level ?? 0}:${bullet}${text}`
            }),
          ),
        )
        return { path: r?.path, lines, dirty: await api.isDirty() }
      })
      expect(deck.path).toBe('')
      expect(deck.dirty).toBe(true)
      // title slide, then one slide per main branch of the first sheet, bullets indented
      expect(deck.lines).toEqual([
        ['0:Trip'],
        ['0:Day one', '0:- Museum', '1:- Lunch', '0:- Park'],
        ['0:Day two', '0:- Beach'],
      ])
      expect((await activeTab(page))?.filePath).toBeUndefined()
      await slides.screenshot({ path: shot('convert-result-slides') })

      // ── 3. markdown → map, with a withheld span ──
      await open([notes])
      gen = await generatePage(app)
      await gen.getByTestId('gen-convert').locator('[data-convert="markdown-to-mindmap"]').click()
      await expect(gen.getByTestId('gen-redaction-notice')).toBeVisible()
      await expect(gen.getByTestId('gen-redaction-notice')).toContainText(
        'Hidden parts are carried over as their labels',
      )
      await gen.screenshot({ path: shot('convert-window-redaction-notice') })
      await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])
      await expect.poll(async () => (await activeTab(page))?.kind).toBe('mindmap')
      const mm = await newestPage(app, '://mindmap/')
      const topics = mm.locator('.mm-sheet-host:not([hidden]) me-tpc > .text')
      await expect(topics.first()).toBeVisible({ timeout: 30_000 })
      const titles = await topics.evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''))
      expect(titles).toEqual(
        expect.arrayContaining(['Lesson', 'Warm-up', 'Main', 'Ask {{Name}} first']),
      )
      expect(titles.join('|')).not.toContain('Kim Minji')
      await expect(mm.locator('.mm-save-status')).toHaveAttribute('data-dirty', 'true')
      expect((await activeTab(page))?.filePath).toBeUndefined()
      await mm.screenshot({ path: shot('convert-result-mindmap') })

      // ── the shell knows each conversion: its source and the new tab ──
      const events = await convertedEvents(app)
      expect(events.map((e) => [e.kind, e.target, e.mode, e.sources])).toEqual([
        ['mindmap-to-markdown', 'markdown', 'convert', [map]],
        ['mindmap-to-slides', 'slides', 'convert', [map]],
        ['markdown-to-mindmap', 'mindmap', 'convert', [notes]],
      ])
      const tabIds = (await listTabs(page)).map((t) => t.id)
      for (const e of events) expect(tabIds).toContain(e.tabId)

      // ── no AI anywhere ──
      expect(
        await app.evaluate(() => (globalThis as Record<string, unknown>).__convertE2eStreams),
      ).toBe(0)

      // ── a material of another type offers no conversion ──
      await open([brief])
      gen = await generatePage(app)
      await expect(gen.getByTestId('gen-materials').locator('li')).toHaveCount(0)
      await expect(gen.getByTestId('gen-convert')).toHaveCount(0)
      await cancel(gen)
    } finally {
      await closeAndSaveVideo(launched, 'generate-convert')
    }
  })
})
