/**
 * Group `u/launch-list`: the launch recovery list's two channels. Their
 * handlers sit in `apps/shell/src/main/index.ts` (a shared entry no group can
 * load); `register` below is those twelve lines, over the gate of
 * `apps/shell/src/main/launch-recovery.ts`, loaded afresh per case. The case's
 * `hosts.u.launchList` is what the launch flow published before the first
 * call (`null`: nothing to ask; absent: it has not answered yet); its apply
 * logs `launchList.apply` and resolves or rejects as the case says.
 */
import type { RecoveryListItem } from '../../../../apps/shell/src/shared/recovery-list-api.ts'
import type { Case, Group, View } from '../../types.ts'

const MODULE = 'apps/shell/src/main/launch-recovery.ts'
type LaunchRecovery = typeof import('../../../../apps/shell/src/main/launch-recovery.ts')

const row = (id: string, more: Partial<RecoveryListItem> = {}): RecoveryListItem => ({
  id,
  editorKind: more.editorKind ?? 'docs',
  name: more.name ?? `${id}.docx`,
  folder: more.folder === undefined ? '$DIR/documents' : more.folder,
  lastCopyTime: more.lastCopyTime ?? 1_763_000_000_000,
  untitled: more.untitled ?? false,
  fileChangedAfterCopy: more.fileChangedAfterCopy ?? false,
  originalMissing: more.originalMissing ?? false,
})
const ROWS = [
  row('a'),
  row('b', {
    editorKind: 'sheets',
    name: '제목 없음',
    folder: null,
    untitled: true,
    lastCopyTime: 5.5,
  }),
  row('c', {
    editorKind: 'hwp',
    name: '보고서.hwp',
    fileChangedAfterCopy: true,
    originalMissing: true,
  }),
]
const asking = (apply = 'ok') => ({ u: { launchList: { items: ROWS, apply } } })
const SHELL: View = { view: 1, window: 1, surface: 'Shell' }
const MANUAL: View = { view: 3, window: 3, surface: 'Shell' }
const get = (view = 1) => ({ channel: 'recovery:get-launch-list', view, args: [] })
const submit = (result: unknown, view = 1) => ({
  channel: 'recovery:submit-launch-list',
  view,
  args: [result],
})
const decide = (decisions: Record<string, unknown>) => submit({ decisions })

const cases: Case[] = [
  { note: 'nothing to ask', hosts: { u: { launchList: null } }, calls: [get(), decide({})] },
  { note: 'the rows, as often as Home asks', hosts: asking(), calls: [get(), get()] },
  {
    note: 'restore and discard; a row the list never showed is dropped; then nothing is asked',
    hosts: asking(),
    calls: [decide({ a: 'restore', c: 'discard', zz: 'restore' }), get(), decide({ a: 'discard' })],
  },
  { note: 'closed without choosing', hosts: asking(), calls: [submit({ dismissed: true }), get()] },
  {
    note: 'dismissed must be true to count',
    hosts: asking(),
    calls: [submit({ dismissed: 1 }), submit({ dismissed: false, decisions: {} })],
  },
  {
    note: 'answers that are not a result',
    hosts: asking(),
    calls: [
      submit(null),
      submit('restore'),
      submit([1]),
      submit({ $: 'u' }),
      submit({}),
      submit({ decisions: null }),
      submit({ decisions: ['restore'] }),
      { channel: 'recovery:submit-launch-list', view: 1, args: [] },
    ],
  },
  {
    note: 'an unknown choice, also for a row the list never showed',
    hosts: asking(),
    calls: [decide({ a: 'later' }), decide({ zz: 0 }), get()],
  },
  {
    note: 'a failed apply leaves the list up',
    hosts: asking('reject'),
    calls: [decide({ a: 'restore' }), get()],
  },
  {
    note: 'the launch flow has not answered: a submit resolves at once',
    calls: [decide({ a: 'restore' })],
  },
  {
    note: 'another view on the shell preload (the manual) gets nothing and may not answer',
    views: [SHELL, MANUAL],
    hosts: asking(),
    calls: [get(3), submit({ dismissed: true }, 3), get(1)],
  },
  {
    note: 'no shell window at all',
    views: [{ view: 4, window: 4, surface: 'ShellUpdate' }],
    hosts: asking(),
    calls: [get(4)],
  },
]

export const group: Group = {
  batch: 'U',
  async load(cx) {
    const { electron } = cx
    const { createLaunchListGate } = await cx.fresh<LaunchRecovery>(MODULE)
    const launchListGate = createLaunchListGate()
    const main = (cx.case.views ?? [SHELL]).find((v) => (v.surface ?? 'Shell') === 'Shell')
    const shellWindow = main ? { webContents: electron.contents(main.view) } : null
    const ipcMain = electron.ipcMain as {
      handle(ch: string, fn: (event: { sender: unknown }, ...args: unknown[]) => unknown): void
    }

    // apps/shell/src/main/index.ts, as is
    ipcMain.handle('recovery:get-launch-list', (event) => {
      // the shell window's Home only (the manual shares the preload)
      if (!shellWindow || event.sender !== shellWindow.webContents) return null
      return launchListGate.get()
    })
    ipcMain.handle('recovery:submit-launch-list', async (event, result: unknown) => {
      if (!shellWindow || event.sender !== shellWindow.webContents) {
        throw new Error('the launch recovery list belongs to the main window')
      }
      await launchListGate.submit(result)
    })

    const u = (cx.case.hosts?.u ?? {}) as {
      launchList?: { items: RecoveryListItem[]; apply: string } | null
    }
    if (u.launchList === null) launchListGate.publishNone()
    else if (u.launchList) {
      const { items, apply } = u.launchList
      launchListGate.publish(items, async (result) => {
        electron.log.push(['launchList.apply', result])
        if (apply === 'reject') throw new Error('apply failed')
      })
    }
  },
  cases,
}
