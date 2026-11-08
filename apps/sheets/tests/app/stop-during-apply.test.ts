// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { t } from '../../src/renderer/i18n/locale'
import { aiRunLock } from '../../src/renderer/univer-state'
import { cellOf, setCell } from '../univer-workbook'
import { commitGate, mounted } from './minimal-univer'
import {
  clickButton,
  mountSheetsApp,
  sendFromComposer,
  type MountedApp,
  type ScriptedTurn,
} from './mount-sheets-app'

/** the first test of a file imports and mounts the whole app */
const APP_TEST_TIMEOUT_MS = 120_000

let app: MountedApp | null = null
afterEach(async () => {
  await app?.unmount()
  app = null
  commitGate.held = null
  aiRunLock.stranded = false
  aiRunLock.proposalPending = false
})

const hasButton = (target: MountedApp, text: string): boolean =>
  [...target.host.querySelectorAll('button')].some((button) => button.textContent === text)

/** A run whose propose_operations apply is paused (in flight) until the returned release runs. */
function pausedApplyTurns(release: { fn: () => void }): ScriptedTurn[] {
  return [
    (emit) => {
      release.fn = commitGate.hold()
      emit({
        type: 'tool-call',
        toolCall: {
          id: 'call-1',
          name: 'propose_operations',
          input: {
            summary: 'fill A1',
            operations: [{ op: 'set_cell', sheetId: 'sheet-1', address: 'A1', value: 99 }],
          },
        },
      })
      emit({ type: 'done' })
    },
    (emit) => {
      emit({ type: 'delta', text: 'Done.' })
      emit({ type: 'done' })
    },
  ]
}

describe('the person acts while a propose_operations apply is in flight (real App)', () => {
  for (const [label, act] of [
    ['Stop', (target: MountedApp) => clickButton(target, t('aiStop'))],
    ['New chat', (target: MountedApp) => clickButton(target, t('aiNewChat'))],
  ] as const) {
    it(
      `${label}: the workbook equals the pre-run state, the lock is consistent, and a later send works`,
      async () => {
        const release = { fn: () => {} }
        app = await mountSheetsApp(pausedApplyTurns(release))
        const runtime = mounted.runtime!
        setCell(runtime, 'C3', 7) // the person's own cell before the run

        await sendFromComposer(app, 'fill A1')
        expect(aiRunLock.active).toBe(true)
        await act(app)

        release.fn()
        await app.settle()
        await app.settle()

        expect(cellOf(runtime, 'A1')).toBeNull() // no AI edit left in the workbook
        expect(cellOf(runtime, 'C3')).toBe(7)
        expect(aiRunLock.active).toBe(false)
        expect(aiRunLock.stranded).toBe(false)

        // Stop leaves the run held as a proposal; the person decides before the next request
        const held = hasButton(app, t('aiProposalAccept'))
        expect(held).toBe(label === 'Stop')
        if (held) await clickButton(app, t('aiProposalReject'))

        await sendFromComposer(app, 'hello again')
        await app.settle()
        expect(app.streamRequests).toHaveLength(2)
        expect(aiRunLock.active).toBe(false)
        expect(cellOf(runtime, 'A1')).toBeNull()
        expect(cellOf(runtime, 'C3')).toBe(7)
      },
      APP_TEST_TIMEOUT_MS,
    )
  }

  it(
    'the app unmounting: the lock is not left held (the unmounted workbook is disposed with the window)',
    async () => {
      const release = { fn: () => {} }
      app = await mountSheetsApp(pausedApplyTurns(release))
      setCell(mounted.runtime!, 'C3', 7)

      await sendFromComposer(app, 'fill A1')
      expect(aiRunLock.active).toBe(true)
      await app.unmount()
      release.fn()
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(aiRunLock.active).toBe(false)
      expect(aiRunLock.stranded).toBe(false)
    },
    APP_TEST_TIMEOUT_MS,
  )
})
