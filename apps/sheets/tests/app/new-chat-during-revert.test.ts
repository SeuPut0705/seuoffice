// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { t } from '../../src/renderer/i18n/locale'
import { aiRunLock } from '../../src/renderer/univer-state'
import { cellOf } from '../univer-workbook'
import { commitGate, mounted } from './minimal-univer'
import { clickButton, mountSheetsApp, sendFromComposer, type MountedApp } from './mount-sheets-app'

/** the first test of a file imports and mounts the whole app */
const APP_TEST_TIMEOUT_MS = 120_000

let app: MountedApp | null = null
afterEach(async () => {
  await app?.unmount()
  app = null
  aiRunLock.stranded = false
  aiRunLock.proposalPending = false
})

describe('"New chat" while a run is being taken back out, then a new send (real App)', () => {
  it(
    'starts the second run only after the first run is reverted, and keeps the second run locked',
    async () => {
      let releaseApply = () => {}
      app = await mountSheetsApp([
        (emit) => {
          // the run's edit is still being applied when the person starts a new chat
          releaseApply = commitGate.hold()
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
        () => undefined, // the second run waits for the model
      ])
      const runtime = mounted.runtime!

      await sendFromComposer(app, 'fill A1')
      expect(aiRunLock.active).toBe(true)
      expect(app.streamRequests).toHaveLength(1) // its tool call waits for the apply

      await clickButton(app, t('aiNewChat'))
      await sendFromComposer(app, 'a second request')
      // the first run's revert is still waiting for its apply: the second run must not start
      expect(app.streamRequests).toHaveLength(1)

      releaseApply()
      await app.settle()

      expect(app.streamRequests).toHaveLength(2)
      expect(cellOf(runtime, 'A1')).toBeNull() // the first run's edit was taken back out first
      expect(aiRunLock.active).toBe(true) // and the late release of the first run did not unlock the second
    },
    APP_TEST_TIMEOUT_MS,
  )
})
