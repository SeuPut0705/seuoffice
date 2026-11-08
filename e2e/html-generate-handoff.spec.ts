import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { closeAndSaveVideo, launchShell, screenshotPath } from './helpers'

/**
 * "Make" → a new HTML tab that takes the request (8.5), on the built app.
 *
 * Nothing reaches Claude or Codex: the main process's `ai:stream` handler and
 * the subscription status handlers are replaced by stubs before any tab
 * opens, and status pushes from the real checker are kept away from the tabs,
 * so every status the editor sees is the one this test sets.
 *
 * Run (after building the shell and the editors):
 *   npx playwright test --config apps/html/tests/e2e/playwright.config.ts
 */

const EVIDENCE_DIR = process.env.HANDOFF_EVIDENCE_DIR
const shot = (name: string) =>
  EVIDENCE_DIR ? join(EVIDENCE_DIR, `${name}.png`) : screenshotPath(name)

type State = 'ready' | 'signed-out' | 'not-installed'

/** replace the AI channels in the main process with stubs (see the file comment) */
async function stubAi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, webContents }) => {
    const g = globalThis as Record<string, unknown>
    g.__handoffE2eRequests = []
    g.__handoffE2eStatuses = {}
    // the real checker's pushes never reach a tab; the test's own pushes go through `realSend`
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]) as {
      send: (channel: string, ...args: unknown[]) => void
    }
    const realSend = proto.send
    g.__handoffE2eRealSend = realSend
    proto.send = function (this: unknown, channel: string, ...args: unknown[]) {
      if (channel === 'ai:subscription-changed') return
      return realSend.call(this, channel, ...args)
    }
    const statuses = () => g.__handoffE2eStatuses
    for (const channel of ['ai:subscription-statuses', 'ai:subscription-recheck']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => statuses())
    }
    ipcMain.removeHandler('ai:stream')
    ipcMain.handle('ai:stream', (event, request: { requestId: string; system: string }) => {
      ;(g.__handoffE2eRequests as unknown[]).push(request)
      const send = (chunk: Record<string, unknown>) =>
        realSend.call(event.sender, 'ai:stream-chunk', { requestId: request.requestId, ...chunk })
      send({ type: 'delta', text: 'Stub reply: nothing was generated.' })
      send({ type: 'done' })
    })
  })
}

/** set the subscription statuses every tab sees, and tell the open tabs */
async function setStatuses(app: ElectronApplication, claude: State, codex: State): Promise<void> {
  await app.evaluate(
    ({ webContents }, [c, x]) => {
      const g = globalThis as Record<string, unknown>
      const map = {
        'claude-code': { provider: 'claude-code', state: c, meteredAccepted: false },
        codex: { provider: 'codex', state: x, meteredAccepted: false },
      }
      g.__handoffE2eStatuses = map
      const realSend = g.__handoffE2eRealSend as (
        this: unknown,
        channel: string,
        ...args: unknown[]
      ) => void
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) realSend.call(wc, 'ai:subscription-changed', map)
      }
    },
    [claude, codex] as const,
  )
}

interface AiRequestView {
  system: string
  text: string
}

const aiRequests = (app: ElectronApplication) =>
  app.evaluate((): AiRequestView[] =>
    (
      ((globalThis as Record<string, unknown>).__handoffE2eRequests ?? []) as Array<{
        system: string
        messages: unknown[]
      }>
    ).map((r) => ({ system: r.system, text: JSON.stringify(r.messages) })),
  )

/** the main process's hand-off store, as plain data */
const handoffStore = (app: ElectronApplication) =>
  app.evaluate(() => {
    const store = (globalThis as Record<symbol, unknown>)[
      Symbol.for('genoffice.generate-handoff')
    ] as
      | {
          queued: Map<number, unknown>
          taken: Map<number, unknown>
          runs: Array<{ target: string; sources: string[]; handoffId: string }>
        }
      | undefined
    return {
      queued: store?.queued.size ?? 0,
      taken: store?.taken.size ?? 0,
      runs: (store?.runs ?? []).map((r) => ({ target: r.target, sources: r.sources })),
    }
  })

/** the live html editor page (a closed tab's page drops out) */
async function htmlPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000
  for (;;) {
    for (const candidate of app.windows()) {
      if (candidate.isClosed()) continue
      const href = await candidate.evaluate(() => window.location.href).catch(() => '')
      if (href.includes('://html/')) return candidate
    }
    if (Date.now() > deadline) throw new Error('no html editor page')
    await app.waitForEvent('window', { timeout: 1_000 }).catch(() => {})
  }
}

async function make(app: ElectronApplication, shell: Page, paths: string[], request: string) {
  await shell.evaluate((p) => window.aiOfficeGenerate.openWithPaths(p), paths)
  let gen: Page | null = null
  const deadline = Date.now() + 30_000
  while (!gen) {
    for (const candidate of app.windows()) {
      const href = await candidate.evaluate(() => window.location.href).catch(() => '')
      if (href.includes('generate.html')) gen = candidate
    }
    if (!gen && Date.now() > deadline) throw new Error('no generate window')
    if (!gen) await app.waitForEvent('window', { timeout: 1_000 }).catch(() => {})
  }
  await expect(gen.getByTestId('generate-window')).toBeVisible()
  await expect(gen.locator('li[data-state="ready"]')).toHaveCount(paths.length)
  await gen.locator('[data-kind="html"]').click()
  await gen.locator('#gen-request').fill(request)
  await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])
  await expect
    .poll(
      async () =>
        (await shell.evaluate(() => window.aiOfficeTabs.list())).find((t) => t.active)?.kind,
    )
    .toBe('html')
}

async function openPanel(editor: Page): Promise<void> {
  await expect(editor.locator('.ai-dock')).toBeVisible()
  if (!(await editor.locator('.copilot').isVisible())) await editor.locator('.ai-rail').click()
  await expect(editor.locator('.copilot')).toBeVisible()
}

const chipNames = (editor: Page, scope: string) =>
  editor.locator(`${scope} .ai-attachment-card-name`).allTextContents()

test('make → a new HTML tab takes the request: blocked keeps it, a later send and an immediate run count', async () => {
  test.setTimeout(240_000)
  const dir = await mkdtemp(join(tmpdir(), 'genoffice-html-handoff-e2e-'))
  const lesson = join(dir, 'lesson.txt')
  const notes = join(dir, 'notes.md')
  await writeFile(lesson, 'Photosynthesis turns light into chemical energy.\n')
  await writeFile(notes, '# Notes\n\n- chlorophyll\n- glucose\n')
  if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

  const launched = await launchShell({ onboardingSeen: true, videoDir: 'html-generate-handoff' })
  const { app, page } = launched
  try {
    await stubAi(app)

    // ── 1. not connected: the tab opens, the connect prompt shows, the request and materials stay ──
    await setStatuses(app, 'signed-out', 'not-installed')
    await make(app, page, [lesson, notes], 'A one-page handout for a science class')
    let editor = await htmlPage(app)
    await openPanel(editor)
    const composer = editor.locator('.ai-input-box textarea')
    await expect(composer).toHaveValue('A one-page handout for a science class')
    await expect
      .poll(() => chipNames(editor, '.ai-attachments'))
      .toEqual(['lesson.txt', 'notes.md'])
    await expect(editor.locator('.ai-sub-prompt')).toBeVisible()
    expect(await aiRequests(app)).toEqual([])
    expect(await handoffStore(app)).toEqual({ queued: 0, taken: 1, runs: [] })
    await editor.screenshot({ path: shot('handoff-blocked-kept') })

    // connecting does not start it by itself
    await setStatuses(app, 'ready', 'not-installed')
    await expect(editor.locator('.ai-sub-prompt')).toHaveCount(0)
    await new Promise((r) => setTimeout(r, 1500))
    expect(await aiRequests(app)).toEqual([])
    await expect(composer).toHaveValue('A one-page handout for a science class')

    // the user sends from that tab: the run starts and counts
    await editor.locator('.ai-send-btn').click()
    await expect.poll(async () => (await aiRequests(app)).length).toBe(1)
    const first = (await aiRequests(app))[0]!
    expect(first.text).toContain('A one-page handout for a science class')
    expect(first.text + first.system).toContain('lesson.txt')
    expect(first.system).not.toContain('WRITE CONTENT')
    await expect
      .poll(() => chipNames(editor, '.ai-msg-attachments'))
      .toEqual(['lesson.txt', 'notes.md'])
    await expect(composer).toHaveValue('')
    await expect
      .poll(() => handoffStore(app))
      .toEqual({ queued: 0, taken: 0, runs: [{ target: 'html', sources: [lesson, notes] }] })
    await editor.screenshot({ path: shot('handoff-sent-after-connect') })

    // a reload takes nothing and starts nothing
    await editor.reload()
    editor = await htmlPage(app)
    await openPanel(editor)
    await new Promise((r) => setTimeout(r, 2000))
    await expect(editor.locator('.ai-input-box textarea')).toHaveValue('')
    expect(await aiRequests(app)).toHaveLength(1)
    expect((await handoffStore(app)).runs).toHaveLength(1)

    // ── 2. connected: "make" starts the run at once ──
    const tabs = await page.evaluate(() => window.aiOfficeTabs.list())
    await page.evaluate(
      (id) => window.aiOfficeTabs.close(id),
      tabs.find((t) => t.kind === 'html')!.id,
    )
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.aiOfficeTabs.list())).filter((t) => t.kind === 'html')
            .length,
      )
      .toBe(0)
    await make(app, page, [notes], 'A poster about chlorophyll')
    editor = await htmlPage(app)
    await openPanel(editor)
    await expect.poll(async () => (await aiRequests(app)).length).toBe(2)
    expect((await aiRequests(app))[1]!.text).toContain('A poster about chlorophyll')
    await expect.poll(() => chipNames(editor, '.ai-msg-attachments')).toEqual(['notes.md'])
    await expect(editor.locator('.ai-input-box textarea')).toHaveValue('')
    await expect
      .poll(async () => (await handoffStore(app)).runs)
      .toEqual([
        { target: 'html', sources: [lesson, notes] },
        { target: 'html', sources: [notes] },
      ])
    await editor.screenshot({ path: shot('handoff-immediate-run') })
  } finally {
    await closeAndSaveVideo(launched, 'html-generate-handoff')
  }
})
