import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'

/**
 * The PPT editor takes a request handed over by the "make" window (spec 8.5),
 * on the built app: "make" opens a new slides tab; the tab takes the request,
 * attaches the materials to its AI panel and puts the text in the composer.
 * With nothing connected the connect prompt shows and the text and the
 * attachments stay; once a provider is connected the user's own send is the
 * run that counts as started. A reload takes nothing and starts nothing.
 *
 * Nothing here reaches Claude or Codex: before "make" is pressed the
 * subscription status handlers and `ai:stream` / `ai:stream-cancel` are
 * replaced in the main process, the real status broadcast is filtered out so
 * only the scripted statuses reach a view ("connected" is a status the test
 * answers itself), and the stream stub records the request and replies with a
 * fixed text. As a second layer the app runs with a PATH and a home that hold
 * no CLI, so the real status check finds nothing to start.
 */

const EVIDENCE_DIR = process.env.GENERATE_EVIDENCE_DIR
const shot = (name: string) =>
  EVIDENCE_DIR ? join(EVIDENCE_DIR, `${name}.png`) : screenshotPath(name)

const REQUEST = 'Make a kickoff deck from the brief and the notes'

/** the main process's hand-off store and the stubbed stream, as plain data */
interface Snapshot {
  queued: number
  taken: number
  runs: Array<{ target: string; mode: string; sources: string[] }>
  streams: number
}

test.describe('generate hand-off: PPT editor', () => {
  test('make → slides tab: attachments and text in the composer, held by the gate, run on send', async () => {
    test.setTimeout(240_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-handoff-slides-e2e-'))
    const brief = join(dir, 'brief.md')
    const notes = join(dir, 'notes.txt')
    await writeFile(brief, '# Kickoff brief\n\nGoals, owners and dates for the project.\n')
    await writeFile(notes, 'Budget approved. Launch in March. Three workstreams.\n')
    // a home with no CLI in it, and a PATH with only Windows' own folders
    const home = join(dir, 'home')
    await mkdir(join(home, 'AppData', 'Roaming'), { recursive: true })
    await mkdir(join(home, 'AppData', 'Local'), { recursive: true })
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const barepath = [join(systemRoot, 'System32'), systemRoot].join(';')
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({
      onboardingSeen: true,
      videoDir: 'generate-handoff-slides',
      env: {
        PATH: barepath,
        Path: barepath,
        USERPROFILE: home,
        HOME: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
      },
    })
    const { app, page } = launched
    const snapshot = () =>
      app.evaluate((): Snapshot => {
        const g = globalThis as unknown as Record<symbol | string, unknown>
        const store = g[Symbol.for('genoffice.generate-handoff')] as
          | {
              queued: Map<number, unknown>
              taken: Map<number, unknown>
              runs: Array<{ target: string; mode: string; sources: string[] }>
            }
          | undefined
        const streams = (g.__t15Streams as unknown[] | undefined)?.length ?? 0
        if (!store) return { queued: 0, taken: 0, runs: [], streams }
        return {
          queued: store.queued.size,
          taken: store.taken.size,
          runs: store.runs.map((r) => ({ target: r.target, mode: r.mode, sources: r.sources })),
          streams,
        }
      })
    try {
      // the script runner wraps named functions in a helper the main process does not have
      await app.evaluate('globalThis.__name = (fn) => fn' as never)
      // Before anything can take the request: the AI run and the subscription statuses are
      // scripted, and the real status broadcast never reaches a view, so no tab can pass
      // the send gate on a subscription signed in on this machine
      await app.evaluate(({ ipcMain, webContents }) => {
        const g = globalThis as unknown as Record<string, unknown>
        g.__t15Streams = []
        g.__t15Statuses = {
          'claude-code': {
            provider: 'claude-code',
            state: 'not-installed',
            meteredAccepted: false,
          },
          codex: { provider: 'codex', state: 'not-installed', meteredAccepted: false },
        }
        const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]!) as {
          send: (this: unknown, channel: string, ...args: unknown[]) => void
        }
        const send = proto.send
        g.__t15Send = send
        proto.send = function (this: unknown, channel: string, ...args: unknown[]) {
          if (channel === 'ai:subscription-changed') return
          send.call(this, channel, ...args)
        }
        for (const channel of [
          'ai:subscription-statuses',
          'ai:subscription-recheck',
          'ai:stream',
          'ai:stream-cancel',
        ]) {
          ipcMain.removeHandler(channel)
        }
        ipcMain.handle('ai:subscription-statuses', () => g.__t15Statuses)
        ipcMain.handle('ai:subscription-recheck', () => g.__t15Statuses)
        ipcMain.handle('ai:stream-cancel', () => undefined)
        ipcMain.handle('ai:stream', (event, request: { requestId: string }) => {
          ;(g.__t15Streams as unknown[]).push(request)
          const send = (chunk: Record<string, unknown>) =>
            event.sender.send('ai:stream-chunk', { requestId: request.requestId, ...chunk })
          send({ type: 'delta', text: 'Stub reply: the deck outline is ready.' })
          send({ type: 'done', stopReason: 'end_turn' })
        })
      })

      // ── "make" from Home: slides is the default kind ──
      await page.evaluate((paths) => window.aiOfficeGenerate.openWithPaths(paths), [brief, notes])
      const gen = await waitForPageWithUrl(app, 'generate.html')
      await expect(gen.getByTestId('generate-window')).toBeVisible()
      await expect(gen.locator('li[data-state="ready"]')).toHaveCount(2)
      await gen.locator('[data-kind="slides"]').click()
      await gen.locator('#gen-request').fill(REQUEST)
      await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])

      // ── the new tab took the request: attachments + text, the connect prompt, no run ──
      const editor: Page = await waitForPageWithUrl(app, '://slides/')
      const composer = editor.locator('textarea[data-slides-ai-input]')
      await expect(composer).toHaveValue(REQUEST, { timeout: 30_000 })
      const chips = editor.locator('.ai-attachments .ai-attachment-card')
      await expect(chips).toHaveCount(2)
      await expect(chips.nth(0)).toHaveAttribute('data-tip', brief)
      await expect(chips.nth(1)).toHaveAttribute('data-tip', notes)
      await expect(editor.locator('.ai-sub-prompt')).toBeVisible()
      await expect.poll(snapshot).toEqual({ queued: 0, taken: 1, runs: [], streams: 0 })
      await editor.screenshot({ path: shot('slides-handoff-not-connected') })

      // ── the user connects (the test answers "ready") and sends what was left ──
      await app.evaluate(({ webContents }) => {
        const g = globalThis as unknown as Record<string, unknown>
        g.__t15Statuses = {
          'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false },
          codex: { provider: 'codex', state: 'not-installed', meteredAccepted: false },
        }
        // through the saved send: the patched one drops status pushes
        const send = g.__t15Send as (this: unknown, channel: string, ...args: unknown[]) => void
        for (const wc of webContents.getAllWebContents()) {
          if (!wc.isDestroyed()) send.call(wc, 'ai:subscription-changed', g.__t15Statuses)
        }
      })
      await expect(editor.locator('.ai-sub-prompt')).toHaveCount(0)
      // still nothing sent by itself after the sign-in
      expect((await snapshot()).streams).toBe(0)
      await composer.focus()
      await composer.press('Enter')
      await expect.poll(async () => (await snapshot()).streams).toBeGreaterThan(0)
      await expect
        .poll(async () => (await snapshot()).runs)
        .toEqual([{ target: 'slides', mode: 'ai', sources: [brief, notes] }])
      await expect(composer).toHaveValue('')
      await expect(editor.locator('.ai-msg-attachments .ai-attachment-card')).toHaveCount(2)
      await expect(editor.getByText('Stub reply: the deck outline is ready.')).toBeVisible()
      await editor.screenshot({ path: shot('slides-handoff-sent') })

      // ── a reload takes nothing and starts nothing ──
      const before = await snapshot()
      await editor.reload()
      const reloaded = await waitForPageWithUrl(app, '://slides/')
      await expect(reloaded.locator('textarea[data-slides-ai-input]')).toBeVisible({
        timeout: 30_000,
      })
      await new Promise((r) => setTimeout(r, 3000))
      await expect(reloaded.locator('textarea[data-slides-ai-input]')).toHaveValue('')
      await expect(reloaded.locator('.ai-attachments .ai-attachment-card')).toHaveCount(0)
      expect(await snapshot()).toEqual(before)
      await reloaded.screenshot({ path: shot('slides-handoff-after-reload') })
    } finally {
      await closeAndSaveVideo(launched, 'generate-handoff-slides')
    }
  })
})
