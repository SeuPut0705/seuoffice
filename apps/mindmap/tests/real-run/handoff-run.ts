/**
 * Real-run check of the generate hand-off (spec 8.5) on the built shell: the
 * make window hands a request to a new mind map tab, and that tab's AI panel
 * takes it.
 *
 * The shared AI channels are replaced in the main process before any panel
 * asks: the subscription statuses (first "nothing connected", then "Claude
 * ready") and the stream channel, which answers with a scripted `write_map`.
 * The real status broadcast is filtered out so only the scripted statuses
 * reach the panels. No `claude` or `codex` program is started by any run here.
 *
 *   npm run build:all
 *   npx tsx apps/mindmap/tests/real-run/handoff-run.ts
 *
 * Screenshots and `result.json` go to MINDMAP_HANDOFF_RUN_OUT (a temp folder
 * when not set).
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUBSCRIPTION_IPC_CHANNELS } from '@genoffice/ai-provider/browser'
import { AI_CHANNELS } from '../../src/shared/ipc'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from '../../../../e2e/helpers'

const OUT =
  process.env.MINDMAP_HANDOFF_RUN_OUT ?? mkdtempSync(join(tmpdir(), 'mindmap-handoff-run-'))
mkdirSync(OUT, { recursive: true })

const checks: string[] = []
function check(condition: unknown, what: string): void {
  if (!condition) throw new Error(`CHECK FAILED: ${what}`)
  checks.push(what)
  console.log(`  ok  ${what}`)
}

const OUTLINE = '# Field trip\n\n- Field trip\n  - Before\n  - On the day\n  - After\n'
const REQUEST = 'Make a mind map of the trip plan'

interface MainState {
  requests: number
  queued: number
  taken: number
  runs: Array<{ sources: string[]; target: string; mode: string }>
}

async function stubAi(app: ElectronApplication): Promise<void> {
  // the script runner wraps named functions in a helper the main process does not have
  await app.evaluate('globalThis.__name = (fn) => fn' as never)
  await app.evaluate(
    ({ ipcMain, webContents }, wiring) => {
      const g = globalThis as unknown as Record<string, unknown>
      const status = (provider: string, state: string) => ({
        provider,
        state,
        meteredAccepted: false,
      })
      g.__statuses = {
        'claude-code': status('claude-code', 'signed-out'),
        codex: status('codex', 'not-installed'),
      }
      g.__connected = {
        'claude-code': status('claude-code', 'ready'),
        codex: status('codex', 'not-installed'),
      }
      g.__requests = 0
      // only the scripted statuses reach the panels
      const anyContents = webContents.getAllWebContents()[0]!
      const proto = Object.getPrototypeOf(anyContents) as {
        send: (this: unknown, channel: string, ...args: unknown[]) => void
      }
      const send = proto.send
      g.__send = send
      proto.send = function (this: unknown, channel: string, ...args: unknown[]) {
        if (channel === wiring.changed) return
        send.call(this, channel, ...args)
      }
      for (const channel of [wiring.statuses, wiring.recheck, wiring.stream, wiring.cancel]) {
        ipcMain.removeHandler(channel)
      }
      ipcMain.handle(wiring.statuses, () => g.__statuses)
      ipcMain.handle(wiring.recheck, () => g.__statuses)
      ipcMain.handle(wiring.cancel, () => undefined)
      // two requests per run: the map writing, then the closing words
      ipcMain.handle(wiring.stream, (event, request: { requestId: string }) => {
        const nth = ((g.__requests as number) += 1)
        const reply =
          nth % 2 === 1
            ? [
                {
                  type: 'tool-call',
                  toolCall: {
                    id: `call-${nth}`,
                    name: 'write_map',
                    input: { outline: wiring.outline },
                  },
                },
                { type: 'done' },
              ]
            : [{ type: 'delta', text: 'Wrote the map.' }, { type: 'done' }]
        setTimeout(() => {
          for (const chunk of reply) {
            event.sender.send(wiring.chunk, { requestId: request.requestId, ...chunk })
          }
        }, 300)
      })
    },
    {
      stream: AI_CHANNELS.stream,
      cancel: AI_CHANNELS.streamCancel,
      chunk: AI_CHANNELS.streamChunk,
      statuses: SUBSCRIPTION_IPC_CHANNELS.statuses,
      recheck: SUBSCRIPTION_IPC_CHANNELS.recheck,
      changed: SUBSCRIPTION_IPC_CHANNELS.changed,
      outline: OUTLINE,
    },
  )
}

/** the user signs in: the scripted statuses say "Claude ready" and every view hears about it */
async function connect(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents }, changed) => {
    const g = globalThis as unknown as Record<string, unknown>
    g.__statuses = g.__connected
    const send = g.__send as (this: unknown, channel: string, ...args: unknown[]) => void
    for (const wc of webContents.getAllWebContents()) send.call(wc, changed, g.__statuses)
  }, SUBSCRIPTION_IPC_CHANNELS.changed)
}

function mainState(app: ElectronApplication): Promise<MainState> {
  return app.evaluate(() => {
    const g = globalThis as unknown as Record<string | symbol, unknown>
    const store = g[Symbol.for('genoffice.generate-handoff')] as
      | {
          queued: Map<number, unknown>
          taken: Map<number, unknown>
          runs: Array<{ sources: string[]; target: string; mode: string }>
        }
      | undefined
    return {
      requests: (g.__requests as number) ?? 0,
      queued: store?.queued.size ?? 0,
      taken: store?.taken.size ?? 0,
      runs: (store?.runs ?? []).map((r) => ({
        sources: r.sources,
        target: r.target,
        mode: r.mode,
      })),
    }
  })
}

async function mindmapPages(app: ElectronApplication): Promise<Page[]> {
  const pages: Page[] = []
  for (const candidate of app.windows()) {
    const href = await candidate.evaluate(() => window.location.href).catch(() => '')
    if (href.includes('://mindmap/')) pages.push(candidate)
  }
  return pages
}

/** "make" from the generate window with the given files, for a mind map; returns the new tab's page */
async function make(app: ElectronApplication, home: Page, paths: string[]): Promise<Page> {
  const before = new Set(await mindmapPages(app))
  await home.evaluate((list) => window.aiOfficeGenerate.openWithPaths(list), paths)
  const gen = await waitForPageWithUrl(app, 'generate.html')
  await gen.getByTestId('generate-window').waitFor()
  await gen
    .locator('li[data-state="ready"]')
    .nth(paths.length - 1)
    .waitFor()
  await gen.locator('[data-kind="mindmap"]').click()
  await gen.locator('#gen-request').fill(REQUEST)
  await Promise.all([gen.waitForEvent('close'), gen.getByTestId('gen-make').click()])
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const fresh = (await mindmapPages(app)).filter((p) => !before.has(p))
    if (fresh.length > 0) return fresh[0]!
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('no new mind map tab')
}

const chips = (page: Page): Promise<string[]> =>
  page.locator('.ai-attachments .ai-attachment-card-name').allTextContents()
const titles = (page: Page): Promise<string[]> =>
  page
    .locator('.mm-sheet-host:not([hidden]) me-tpc > .text')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? '').sort())
const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`) })

async function settle(page: Page, ms = 1500): Promise<void> {
  await page.waitForTimeout(ms)
}

/** waits until the stream channel saw `requests` requests in all and the panel's reply is done */
async function runDone(app: ElectronApplication, page: Page, requests: number): Promise<void> {
  const deadline = Date.now() + 30_000
  while ((await mainState(app)).requests < requests) {
    if (Date.now() > deadline) throw new Error(`fewer than ${requests} stream requests`)
    await new Promise((r) => setTimeout(r, 200))
  }
  await page.waitForFunction(() => !document.querySelector('.ai-msg-streaming'), undefined, {
    timeout: 30_000,
  })
  await settle(page)
}

async function main(): Promise<void> {
  console.log(`hand-off run, evidence in ${OUT}`)
  const dir = mkdtempSync(join(tmpdir(), 'mindmap-handoff-materials-'))
  const notes = join(dir, 'notes.md')
  const list = join(dir, 'list.txt')
  writeFileSync(notes, '# Trip\n\nWe visit the science museum on Friday.\n')
  writeFileSync(list, 'water\nlunch\nnotebook\n')

  const launched = await launchShell({ onboardingSeen: true, videoDir: 'mindmap-handoff' })
  const { app, page: home } = launched
  try {
    await stubAi(app)

    // ── 1. nothing connected: the tab opens, the request waits in its panel ──
    const blocked = await make(app, home, [notes, list])
    await blocked.locator('.ai-dock[data-ai-open="true"]').waitFor({ timeout: 20_000 })
    await blocked.locator('.ai-sub-prompt').waitFor({ timeout: 20_000 })
    await settle(blocked)
    let state = await mainState(app)
    check(state.queued === 0 && state.taken === 1, 'the new tab took the request (queue empty)')
    check(
      JSON.stringify(await chips(blocked)) === JSON.stringify(['notes.md', 'list.txt']),
      'the handed-over files are attached in the panel, in order',
    )
    check(
      (await blocked.locator('.ai-input-box textarea').inputValue()) === REQUEST,
      'the request text is in the composer',
    )
    check(state.requests === 0, 'blocked: no run reached the stream channel')
    check(state.runs.length === 0, 'blocked: no run-started record')
    await shot(blocked, '1-blocked-request-kept')

    // connecting does not start anything by itself; the user's own send does
    await connect(app)
    await settle(blocked)
    state = await mainState(app)
    check(state.requests === 0, 'after connecting, nothing ran by itself')
    await blocked.locator('.ai-send-btn').click()
    await runDone(app, blocked, 2)
    state = await mainState(app)
    check(state.requests === 2, 'the user’s send ran once (map writing, then the answer)')
    check(
      state.runs.length === 1 &&
        state.runs[0]!.target === 'mindmap' &&
        state.runs[0]!.mode === 'ai' &&
        state.runs[0]!.sources.length === 2,
      'the run was recorded as the hand-off’s start with both files',
    )
    check(
      JSON.stringify(await titles(blocked)) ===
        JSON.stringify(['After', 'Before', 'Field trip', 'On the day']),
      'write_map filled the map',
    )
    check(
      (await blocked.locator('.mm-sheets .mm-sheet-name').allTextContents()).length === 1,
      'the blank new map’s sheet was filled, no second sheet',
    )
    await shot(blocked, '2-after-connect-and-send')

    // a reload takes nothing and runs nothing
    await blocked.reload()
    await blocked.locator('.mm-sheet-host').first().waitFor({ timeout: 20_000 })
    await settle(blocked, 2500)
    state = await mainState(app)
    check(state.requests === 2, 'reload: no new run')
    check((await chips(blocked)).length === 0, 'reload: no files attached again')
    check(
      (await blocked.locator('.ai-input-box textarea').inputValue()) === '',
      'reload: the composer is empty',
    )
    await shot(blocked, '3-after-reload')

    // ── 2. connected: "make" starts the run in the new tab at once ──
    const direct = await make(app, home, [notes])
    await runDone(app, direct, 4)
    state = await mainState(app)
    check(state.requests === 4, 'connected: the hand-off ran once by itself')
    check(state.runs.length === 2 && state.runs[1]!.sources.length === 1, 'and was recorded')
    check(
      JSON.stringify(await titles(direct)) ===
        JSON.stringify(['After', 'Before', 'Field trip', 'On the day']),
      'connected: write_map filled the new map',
    )
    check(
      (await direct.locator('.ai-msg-attachments').first().textContent())?.includes('notes.md'),
      'the run took the handed-over file',
    )
    await shot(direct, '4-connected-run')
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ ok: true, checks }, null, 2))
    console.log(`all ${checks.length} checks passed`)
  } catch (err) {
    writeFileSync(
      join(OUT, 'result.json'),
      JSON.stringify({ ok: false, checks, error: String(err) }, null, 2),
    )
    throw err
  } finally {
    await closeAndSaveVideo(launched, 'mindmap-handoff')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
