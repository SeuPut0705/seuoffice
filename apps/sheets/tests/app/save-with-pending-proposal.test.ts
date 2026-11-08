// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { t } from '../../src/renderer/i18n/locale'
import { aiRunLock } from '../../src/renderer/univer-state'
import { cellOf } from '../univer-workbook'
import { mounted } from './minimal-univer'
import { clickButton, mountSheetsApp, sendFromComposer, type MountedApp } from './mount-sheets-app'

const hasButton = (target: MountedApp, label: string): boolean =>
  [...target.host.querySelectorAll('button')].some((button) => button.textContent === label)

/** the first test of a file imports and mounts the whole app */
const APP_TEST_TIMEOUT_MS = 120_000

let app: MountedApp | null = null
afterEach(async () => {
  await app?.unmount()
  app = null
  aiRunLock.stranded = false
  aiRunLock.proposalPending = false
})

describe('saving while the AI proposal waits for Accept or Reject (real App)', () => {
  it(
    'is refused with a notice to decide first, keeps the proposal, and saves again after Reject',
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

      await sendFromComposer(app, 'fill A1')
      await app.settle()
      // the run is over: its edit is out of the workbook and waits for the person
      expect(cellOf(runtime, 'A1')).toBeNull()
      expect(hasButton(app, t('aiProposalAccept'))).toBe(true)
      expect(aiRunLock.active).toBe(false)

      await app.menuAction('save')
      expect(app.host.textContent).toContain(t('appSaveBlockedProposal'))
      expect(hasButton(app, t('aiProposalAccept'))).toBe(true) // the proposal is still there

      await clickButton(app, t('aiProposalReject'))
      expect(hasButton(app, t('aiProposalAccept'))).toBe(false)
      await app.menuAction('save')
      expect(app.host.textContent).not.toContain(t('appSaveBlockedProposal'))
    },
    APP_TEST_TIMEOUT_MS,
  )
})
