// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { t } from '../../src/renderer/i18n/locale'
import { aiRunLock } from '../../src/renderer/univer-state'
import { cellOf, setCell } from '../univer-workbook'
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

describe('an AI run in the blank workbook (real App)', () => {
  it(
    'takes its edit back out without losing a cell the person typed into the grid',
    async () => {
      app = await mountSheetsApp([
        (emit) => {
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
          emit({ type: 'delta', text: 'Filled A1.' })
          emit({ type: 'done' })
        },
      ])
      const runtime = mounted.runtime!
      setCell(runtime, 'C3', 7) // typed into the grid: the in-memory adapter never sees it

      await sendFromComposer(app, 'fill A1')
      await app.settle()

      expect(cellOf(runtime, 'A1')).toBeNull() // the run's edit is out, held as a proposal
      expect(cellOf(runtime, 'C3')).toBe(7)
    },
    APP_TEST_TIMEOUT_MS,
  )
})

describe('Accept that fails midway in the blank workbook (real App)', () => {
  it(
    'rolls back to the workbook as it stood at Accept, keeping a cell typed while the proposal was held',
    async () => {
      const plan = (id: string, address: string) => (emit: (chunk: never) => void) =>
        (emit as (chunk: unknown) => void)({
          type: 'tool-call',
          toolCall: {
            id,
            name: 'propose_operations',
            input: {
              summary: `fill ${address}`,
              operations: [{ op: 'set_cell', sheetId: 'sheet-1', address, value: 99 }],
            },
          },
        })
      app = await mountSheetsApp([
        (emit) => {
          plan('call-1', 'A1')(emit as never)
          plan('call-2', 'A2')(emit as never)
          emit({ type: 'done' })
        },
        (emit) => {
          emit({ type: 'delta', text: 'Filled.' })
          emit({ type: 'done' })
        },
      ])
      const runtime = mounted.runtime!

      await sendFromComposer(app, 'fill A1 and A2')
      await app.settle()
      expect(cellOf(runtime, 'A1')).toBeNull()

      setCell(runtime, 'C3', 7) // typed after the proposal was held
      commitGate.failAfter = 1 // the first plan re-applies, the second one fails
      await clickButton(app, t('aiProposalAccept'))
      commitGate.failAfter = null

      expect(cellOf(runtime, 'A1')).toBeNull()
      expect(cellOf(runtime, 'A2')).toBeNull()
      expect(cellOf(runtime, 'C3')).toBe(7)
    },
    APP_TEST_TIMEOUT_MS,
  )
})
