import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication } from '@playwright/test'
import { closeAndSaveVideo, launchShell, screenshotPath } from './helpers'

/**
 * Narrowing the home ask to one starred group (spec 8.8), on the built app:
 * the "All / <group>" choice starts at All, a narrowed run lists only the
 * group's files to the model, its reads carry the run's scope, and the main
 * process refuses any starred file outside the group, also when a path is
 * named directly.
 *
 * Nothing here reaches Claude or Codex: the main process's subscription status
 * handlers answer "Claude ready" from a stub, the real status pushes are kept
 * from the window, and `ai:stream` is replaced by a scripted stub that plays
 * the model's two turns.
 */

const EVIDENCE_DIR = process.env.KB_ASK_EVIDENCE_DIR
const shot = (name: string) =>
  EVIDENCE_DIR ? join(EVIDENCE_DIR, `${name}.png`) : screenshotPath(name)

interface Recorded {
  streams: string[]
  reads: Array<{ path: string; scope: unknown; refused: string | null }>
}

/** the AI channels become stubs; kb:read is wrapped to record what the run asked main for */
async function stubAi(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, webContents }) => {
    const g = globalThis as Record<string, unknown>
    const recorded: Recorded = { streams: [], reads: [] }
    g.__kbAskE2e = recorded
    const proto = Object.getPrototypeOf(webContents.getAllWebContents()[0]) as {
      send: (channel: string, ...args: unknown[]) => void
    }
    const realSend = proto.send
    proto.send = function (this: unknown, channel: string, ...args: unknown[]) {
      if (channel === 'ai:subscription-changed') return
      return realSend.call(this, channel, ...args)
    }
    const statuses = {
      'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false },
      codex: { provider: 'codex', state: 'not-installed', meteredAccepted: false },
    }
    for (const channel of ['ai:subscription-statuses', 'ai:subscription-recheck']) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => statuses)
    }
    ipcMain.removeHandler('ai:stream')
    ipcMain.handle('ai:stream', (event, request: { requestId: string }) => {
      recorded.streams.push(JSON.stringify(request))
      const turn = recorded.streams.length
      const send = (chunk: Record<string, unknown>) =>
        event.sender.send('ai:stream-chunk', { requestId: request.requestId, ...chunk })
      setTimeout(() => {
        if (turn === 1) {
          // the model reads the first listed file, then asks for an index past the group's list
          send({
            type: 'tool-call',
            toolCall: { id: 'r1', name: 'read_knowledge_file', input: { index: 0 } },
          })
          send({
            type: 'tool-call',
            toolCall: { id: 'r2', name: 'read_knowledge_file', input: { index: 2 } },
          })
        } else {
          send({ type: 'delta', text: 'Pets are allowed in Unit A.' })
        }
        send({ type: 'done' })
      }, 50)
    })
    // record every kb:read with its scope and outcome (Electron keeps invoke handlers in this map)
    type InvokeHandler = (event: unknown, raw: unknown) => Promise<unknown>
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const realRead = handlers?.get('kb:read')
    if (realRead) {
      ipcMain.removeHandler('kb:read')
      ipcMain.handle('kb:read', async (event, raw: { path: string; scope?: unknown }) => {
        try {
          const page = await realRead(event, raw)
          recorded.reads.push({ path: raw.path, scope: raw.scope, refused: null })
          return page
        } catch (e) {
          recorded.reads.push({ path: raw.path, scope: raw.scope, refused: String(e) })
          throw e
        }
      })
    }
  })
}

test.describe('ask narrowed to a starred group', () => {
  test('the choice, the narrowed run, and main refusing files outside the group', async () => {
    test.setTimeout(180_000)
    const dir = await mkdtemp(join(tmpdir(), 'genoffice-kb-group-e2e-'))
    const a1 = join(dir, 'lease-rules.md')
    const a2 = join(dir, 'house-notes.md')
    const b1 = join(dir, 'salaries.md')
    const loose = join(dir, 'loose-note.md')
    await writeFile(a1, '# Lease rules\n\nUNIT-A-TEXT: pets are allowed.\n')
    await writeFile(a2, '# House notes\n\nThe heating is checked in May.\n')
    await writeFile(b1, '# Salaries\n\nUNIT-B-SECRET: the salary table.\n')
    await writeFile(loose, '# Loose\n\nLOOSE-TEXT nobody grouped.\n')
    if (EVIDENCE_DIR) await mkdir(EVIDENCE_DIR, { recursive: true })

    const launched = await launchShell({ onboardingSeen: true, videoDir: 'kb-ask-group' })
    const { app, page } = launched
    const recorded = () =>
      app.evaluate(() => (globalThis as Record<string, unknown>).__kbAskE2e as Recorded)
    try {
      await page.evaluate(
        async ([all, groupA, groupB]) => {
          for (const p of all) await window.aiOffice.toggleStar(p)
          await window.aiOffice.setStarredGroup(groupA, 'Unit A')
          await window.aiOffice.setStarredGroup(groupB, 'Unit B')
        },
        [[a1, a2, b1, loose], [a1, a2], [b1]] as const,
      )
      await stubAi(app)
      // the window asked the real status handlers at launch: start it again on the stubs
      await page.reload()
      await page.locator('.nav-item', { hasText: 'Ask AI' }).click()

      // ── 1. the choice: All / the groups that have files, All chosen ──
      const choice = page.locator('.kb-ask-scope')
      await expect(choice.getByRole('radio')).toHaveText(['All', 'Unit A', 'Unit B'])
      await expect(choice.getByRole('radio', { name: 'All' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await page.screenshot({ path: shot('ask-scope-choice') })

      // ── 2. main keeps the narrowing, also for a path named directly ──
      const direct = await page.evaluate(
        async ([inA, inB, ungrouped]) => {
          const outcome = async (p: Promise<unknown>): Promise<string> =>
            p.then(
              () => 'read',
              (e: unknown) => `refused: ${String(e)}`,
            )
          const scope = await window.aiOffice.kbOpenScope('Unit A')
          const listed = (await window.aiOffice.kbList(scope)).map((f) => f.path)
          const result = {
            listed,
            inGroup: await outcome(window.aiOffice.kbRead(inA, 0, scope)),
            otherGroup: await outcome(window.aiOffice.kbRead(inB, 0, scope)),
            ungroupedScoped: await outcome(window.aiOffice.kbRead(ungrouped, 0, scope)),
            ungroupedAll: await outcome(window.aiOffice.kbRead(ungrouped, 0)),
            forgedScope: await outcome(window.aiOffice.kbList('made-up-scope')),
            noSuchGroup: await outcome(window.aiOffice.kbOpenScope('No such group')),
            afterClose: '',
          }
          await window.aiOffice.kbCloseScope(scope)
          result.afterClose = await outcome(window.aiOffice.kbRead(inA, 0, scope))
          return result
        },
        [a1, b1, loose] as const,
      )
      expect(direct.listed.sort()).toEqual([a1, a2].sort())
      expect(direct.inGroup).toBe('read')
      expect(direct.otherGroup).toContain('path is not in the knowledge base')
      expect(direct.ungroupedScoped).toContain('path is not in the knowledge base')
      expect(direct.ungroupedAll).toBe('read')
      expect(direct.forgedScope).toContain('knowledge-base scope is not open')
      expect(direct.noSuchGroup).toContain('knowledge-base group has no starred files')
      expect(direct.afterClose).toContain('knowledge-base scope is not open')

      // ── 3. a run narrowed to Unit A ──
      await choice.getByRole('radio', { name: 'Unit A' }).click()
      await expect(choice.getByRole('radio', { name: 'Unit A' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      await page.locator('.kb-ask textarea').fill('What do the rules say about pets?')
      await page.locator('.kb-ask .ai-send-btn').click()
      await expect(page.locator('.kb-ask-assistant').last()).toContainText(
        'Pets are allowed in Unit A.',
      )
      const run = await recorded()
      expect(run.streams).toHaveLength(2)
      // the model was shown the group's files only
      expect(run.streams[0]).toContain(JSON.stringify(a1).slice(1, -1))
      expect(run.streams[0]).toContain(JSON.stringify(a2).slice(1, -1))
      expect(run.streams[0]).not.toContain('salaries.md')
      expect(run.streams[0]).not.toContain('loose-note.md')
      // its read went to main with the run's scope, inside the group
      const runReads = run.reads.slice(-1)
      expect(runReads).toHaveLength(1)
      expect(typeof runReads[0]!.scope).toBe('string')
      expect([a1, a2]).toContain(runReads[0]!.path)
      expect(runReads[0]!.refused).toBeNull()
      // the index past the group's list was refused, and nothing outside the group came back
      expect(run.streams[1]).toContain('no knowledge-base file at index 2')
      expect(run.streams[1]).not.toContain('UNIT-B-SECRET')
      expect(run.streams[1]).not.toContain('LOOSE-TEXT')
      await page.screenshot({ path: shot('ask-scope-narrowed-run') })

      // the run is over: main no longer holds its scope
      const closed = await page.evaluate(
        async ([scope, path]) =>
          window.aiOffice.kbRead(path, 0, scope).then(
            () => 'read',
            (e: unknown) => String(e),
          ),
        [runReads[0]!.scope as string, a1] as const,
      )
      expect(closed).toContain('knowledge-base scope is not open')

      // ── 4. not remembered: the panel opens on All again ──
      await page.locator('.nav-item', { hasText: 'Recent' }).click()
      await page.locator('.nav-item', { hasText: 'Ask AI' }).click()
      await expect(
        page.locator('.kb-ask-scope').getByRole('radio', { name: 'All' }),
      ).toHaveAttribute('aria-checked', 'true')
      await page.screenshot({ path: shot('ask-scope-reopened') })
    } finally {
      await closeAndSaveVideo(launched, 'kb-ask-group')
    }
  })
})
