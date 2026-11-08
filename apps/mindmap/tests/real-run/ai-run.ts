/**
 * Real-run check of the AI panel in the built standalone editor, with a
 * scripted model.
 *
 * The standalone editor registers no AI channels of its own (the docs main
 * does that in the shell). This run registers stand-ins in the main process
 * before the panel asks: the settings, the subscription statuses (Claude
 * `ready`) and the stream channel, which answers with chunks written out
 * below. So the panel, the send gate, the agent loop and the map tools run for
 * real, and no `claude` or `codex` program is ever started.
 *
 * Not part of `npm test`: it needs a build and opens a window.
 *
 *   npm run build -w @genoffice/mindmap
 *   npx tsx apps/mindmap/tests/real-run/ai-run.ts
 *
 * Screenshots and `result.json` go to MINDMAP_AI_RUN_OUT (a temp folder when
 * not set).
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUBSCRIPTION_IPC_CHANNELS } from '@genoffice/ai-provider/browser'
import { createXmindDocumentFromSheets, type XmindTopic } from '@genoffice/xmind-engine'
import { AI_CHANNELS } from '../../src/shared/ipc'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = process.env.MINDMAP_AI_RUN_OUT ?? mkdtempSync(join(tmpdir(), 'mindmap-ai-run-'))
mkdirSync(OUT, { recursive: true })

const checks: string[] = []
function check(condition: unknown, what: string): void {
  if (!condition) throw new Error(`CHECK FAILED: ${what}`)
  checks.push(what)
  console.log(`  ok  ${what}`)
}

const ROOT = '60000000-0000-4000-8000-000000000001'
const topic = (id: string, title: string, attached: XmindTopic[] = []): XmindTopic => ({
  id,
  class: 'topic',
  title,
  ...(attached.length > 0 ? { children: { attached } } : {}),
})

async function mapFile(): Promise<string> {
  const document = await createXmindDocumentFromSheets([
    {
      id: '60000000-0000-4000-8000-0000000000a0',
      class: 'sheet',
      title: '여름 여행',
      rootTopic: topic(ROOT, '여름 여행', [
        topic('60000000-0000-4000-8000-0000000000b1', '장소'),
        topic('60000000-0000-4000-8000-0000000000b2', '일정'),
      ]),
    },
  ])
  const path = join(mkdtempSync(join(tmpdir(), 'mindmap-ai-run-map-')), '여행.xmind')
  writeFileSync(path, await document.save())
  return path
}

/** What the scripted model answers, request by request (the last one repeats). */
const SCRIPT = [
  // the first request: one edit batch, one edit of it naming a topic that is not there
  [
    {
      type: 'tool-call',
      toolCall: {
        id: 'call-1',
        name: 'edit_map',
        input: {
          edits: [
            { op: 'add', parentId: ROOT, title: '준비물', ref: 'pack' },
            { op: 'add', parentId: 'pack', title: '수영복' },
            { op: 'add', parentId: 'pack', title: '<b>자외선 차단제</b>' },
            { op: 'set_title', id: 'no-such-topic', title: 'x' },
          ],
        },
      },
    },
    { type: 'done' },
  ],
  [
    {
      type: 'delta',
      text: '"준비물" 가지를 더했습니다. 없는 토픽을 가리킨 편집 하나는 적용되지 않았습니다.',
    },
    { type: 'done' },
  ],
  // the second request: a whole map on a new sheet
  [
    {
      type: 'tool-call',
      toolCall: {
        id: 'call-2',
        name: 'write_map',
        input: { outline: '# 예산\n\n- 예산\n  - 교통\n  - 숙소\n  - 식비\n' },
      },
    },
    { type: 'done' },
  ],
  [{ type: 'delta', text: '예산 시트를 새로 만들었습니다.' }, { type: 'done' }],
]

async function launch(path: string): Promise<{ app: ElectronApplication; page: Page }> {
  const require = createRequire(join(APP_DIR, 'package.json'))
  const executablePath = require('electron') as unknown as string
  const { ELECTRON_RUN_AS_NODE: _ignored, ...hostEnv } = process.env
  const app = await electron.launch({
    executablePath,
    args: [APP_DIR, path],
    env: {
      ...hostEnv,
      GENOFFICE_USER_DATA: mkdtempSync(join(tmpdir(), 'mindmap-ai-run-profile-')),
      GENOFFICE_LANG: 'ko',
    },
  })
  // The script runner wraps named functions in a helper the main process does not have.
  await app.evaluate('globalThis.__name = (fn) => fn' as never)
  // the stand-ins for the shared AI channels, registered before the window asks
  await app.evaluate(
    ({ ipcMain }, wiring) => {
      const settings: Record<string, unknown> = {
        provider: 'auto',
        providers: {},
        subscriptionNoticeSeen: true,
      }
      const status = (provider: string, state: string) => ({
        provider,
        state,
        meteredAccepted: false,
      })
      const statuses = {
        'claude-code': status('claude-code', 'ready'),
        codex: status('codex', 'not-installed'),
      }
      const seen: unknown[] = []
      ;(globalThis as unknown as { __aiRequests: unknown[] }).__aiRequests = seen
      ipcMain.handle(wiring.getSettings, () => settings)
      ipcMain.handle(wiring.setSettings, (_e, next: Record<string, unknown>) => {
        Object.assign(settings, next)
      })
      ipcMain.handle(wiring.statuses, () => statuses)
      ipcMain.handle(wiring.recheck, () => statuses)
      ipcMain.handle(wiring.cancel, () => undefined)
      ipcMain.handle(wiring.stream, (event, request: { requestId: string }) => {
        seen.push(request)
        const reply = wiring.script[Math.min(seen.length - 1, wiring.script.length - 1)]!
        setTimeout(() => {
          for (const chunk of reply) {
            event.sender.send(wiring.chunk, { requestId: request.requestId, ...chunk })
          }
        }, 400)
      })
    },
    {
      getSettings: AI_CHANNELS.getSettings,
      setSettings: AI_CHANNELS.setSettings,
      stream: AI_CHANNELS.stream,
      cancel: AI_CHANNELS.streamCancel,
      chunk: AI_CHANNELS.streamChunk,
      statuses: SUBSCRIPTION_IPC_CHANNELS.statuses,
      recheck: SUBSCRIPTION_IPC_CHANNELS.recheck,
      script: SCRIPT,
    },
  )
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate('globalThis.__name = (fn) => fn')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1400, 860)
  })
  return { app, page }
}

const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(OUT, `${name}.png`) })

const titles = (page: Page): Promise<string[]> =>
  page
    .locator('.mm-sheet-host:not([hidden]) me-tpc > .text')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? '').sort())

async function ask(page: Page, text: string): Promise<void> {
  await page.locator('.ai-input-box textarea').fill(text)
  await page.locator('.ai-send-btn').click()
  // the reply is done when the composer is idle again
  await page.waitForFunction(() => !document.querySelector('.ai-msg-streaming'), undefined, {
    timeout: 20_000,
  })
  await page.waitForTimeout(300)
}

async function main(): Promise<void> {
  console.log(`AI run of ${APP_DIR}\nevidence in ${OUT}`)
  const path = await mapFile()
  const { app, page } = await launch(path)
  let failure: unknown = null
  try {
    await page.waitForSelector('.mm-sheet-host:not([hidden]) me-tpc')
    const button = page.locator('.mm-tools-end [data-action="ai"]')
    check((await button.count()) === 1, 'the AI button sits at the far end of the toolbar')
    if ((await page.locator('.ai-dock.collapsed').count()) > 0) await button.click()
    await page.waitForSelector('.ai-dock:not(.collapsed) .ai-panel-title')
    await shot(page, '01-panel-open')
    check(
      (await page.locator('.mm-stage > :last-child').getAttribute('class'))?.includes('ai-dock'),
      'the panel is docked at the right end of the map',
    )

    await ask(page, '준비물 가지를 더해 줘')
    const after = await titles(page)
    check(
      after.includes('준비물') && after.includes('수영복'),
      'the edit batch from the model changed the map',
    )
    check(
      after.includes('<b>자외선 차단제</b>'),
      'a title with markup from the model is shown as text',
    )
    check(
      (await page.locator('.mm-sheet-host:not([hidden]) me-tpc b').count()) === 0,
      'no element was made from that title',
    )
    const requests = await app.evaluate(
      () => (globalThis as unknown as { __aiRequests: Array<{ messages: unknown }> }).__aiRequests,
    )
    check(
      JSON.stringify(requests[1]?.messages).includes('3 of 4 edit(s) applied'),
      'the model was told which edit failed and why, the rest applied',
    )
    await shot(page, '02-after-edit-batch')

    // Ctrl+Z on the map: the whole batch is one step
    await page.locator('.mm-sheet-host:not([hidden]) me-tpc').first().click()
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(400)
    const undone = await titles(page)
    check(
      !undone.includes('준비물') &&
        undone.join('|') === ['여름 여행', '일정', '장소'].sort().join('|'),
      'Ctrl+Z took the whole edit batch back',
    )
    await shot(page, '03-after-ctrl-z')
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(400)

    await ask(page, '예산 지도도 만들어 줘')
    check((await page.locator('.mm-sheet-host').count()) === 2, 'write_map added a sheet')
    check((await titles(page)).includes('숙소'), 'the new sheet holds the outline and is on screen')
    await shot(page, '04-after-write-map')

    // the newest turn back: the sheet it added goes
    await page.locator('[data-action="ai-turn-undo"]').last().click()
    await page.waitForTimeout(600)
    check(
      (await page.locator('.mm-sheet-host').count()) === 1,
      'undoing the turn removed the sheet it added',
    )
    await shot(page, '05-after-turn-undo')
  } catch (error) {
    failure = error
    console.error(error)
    await shot(page, '99-failure').catch(() => {})
  } finally {
    await app.close()
  }
  writeFileSync(
    join(OUT, 'result.json'),
    `${JSON.stringify({ checks, passed: failure === null, failure: failure ? String(failure) : undefined }, null, 2)}\n`,
  )
  console.log(failure ? '\nFAILED' : `\nPASSED (${checks.length} checks)`)
  process.exitCode = failure ? 1 : 0
}

void main()
