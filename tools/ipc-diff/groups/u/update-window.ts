/**
 * Group `u/update-window`: the update window's channels
 * (`apps/shell/src/main/update-window.ts`). The module registers
 * `update:get-state` and `update:open-for-update` when it loads; the dialog's
 * four channels only once `showUpdateWindow` ran. A case's `hosts.u.update`
 * is what the updater showed before the first call, done here as the updater
 * does it (`showUpdateWindow(shellWindow, state, actions, {inactive})`, the
 * notes normalized as electron-updater's arrive). The window is a fake
 * `BrowserWindow` whose web contents are the case's `ShellUpdate` view; it
 * logs what crates/shell-ipc/u's probe fakes log (`updateWindow.*`), and the
 * actions log `update.action` as the updater's callbacks would be called.
 */
import { useElectron } from '../../../main-diff/electron-fake.ts'
import { normalizeReleaseNotes } from '../../../../apps/shell/src/main/update-notes.ts'
import type { Case, Group, View } from '../../types.ts'

const MODULE = 'apps/shell/src/main/update-window.ts'
type UpdateWindow = typeof import('../../../../apps/shell/src/main/update-window.ts')

/** an `UpdateUiState` with its keys in the order the updater writes them */
function state(phase: string, more: { releaseNotes?: unknown; title?: string } = {}) {
  const s = (key: string) => `${key}-ko`
  return {
    phase,
    version: '0.13.0',
    currentVersion: '0.12.41',
    percent: phase === 'downloaded' ? 100 : 0,
    lang: 'ko',
    strings: {
      title: more.title ?? '소프트웨어 업데이트',
      headline: s('headline'),
      desc: s('desc'),
      download: s('download'),
      later: s('later'),
      install: s('install'),
      downloading: s('downloading'),
      failed: s('failed'),
      retry: s('retry'),
      manualDesc: s('manualDesc'),
      installFailedDesc: s('installFailedDesc'),
      visibleInstallDesc: s('visibleInstallDesc'),
      restartDesc: s('restartDesc'),
      openDownload: s('openDownload'),
      notesLabel: s('notesLabel'),
      notesOnGitHub: s('notesOnGitHub'),
      notesTruncated: s('notesTruncated'),
    },
    releaseNotes: more.releaseNotes ?? null,
    visibleInstall: false,
  }
}

const SHELL: View = { view: 1, window: 1, surface: 'Shell' }
const DIALOG: View = { view: 2, window: 900, surface: 'ShellUpdate' }
const views = [SHELL, DIALOG]
const call = (channel: string, view = 1, args: unknown[] = []) => ({ channel, view, args })
const shown = (phase: string, inactive = false, more = {}) => ({
  u: { update: [{ state: state(phase, more), inactive }] },
})
/** GitHub's release body as electron-updater hands it over: HTML */
const notes = '<h2>0.13.0</h2><ul><li><strong>New</strong> editor</li><li>faster start</li></ul>'

const cases: Case[] = [
  {
    note: 'Settings asks on mount, before any update is known',
    views,
    calls: [call('update:get-state'), call('update:open-for-update'), call('update:get-state', 2)],
  },
  {
    note: 'the dialog has no handlers before the window was shown',
    views,
    calls: [
      call('update:download', 2),
      call('update:install', 2),
      call('update:later', 2),
      call('update:open-download', 2),
    ],
  },
  {
    note: 'shown without the focus: Settings and the dialog read the state',
    views,
    hosts: shown('available', true),
    calls: [call('update:get-state'), call('update:get-state', 2)],
  },
  {
    note: 'with release notes the card is taller; the notes are normalized',
    views,
    hosts: shown('available', false, { releaseNotes: notes, title: 'Update' }),
    calls: [call('update:get-state', 2)],
  },
  {
    note: 'the dialog buttons reach the updater',
    views,
    hosts: shown('downloaded'),
    calls: [
      call('update:download', 2),
      call('update:install', 2),
      call('update:later', 2),
      call('update:open-download', 2),
    ],
  },
  {
    note: 'shown twice: the open window gets the new state, shown without the focus',
    views,
    hosts: {
      u: {
        update: [
          { state: state('available'), inactive: false },
          { state: state('error'), inactive: true },
        ],
      },
    },
    calls: [call('update:get-state')],
  },
  ...['available', 'error', 'install-failed', 'downloading', 'downloaded', 'manual'].map(
    (phase): Case => ({
      note: `Settings' "update to" in phase ${phase}: shows the window, downloads when nothing started`,
      views,
      hosts: shown(phase),
      calls: [call('update:open-for-update')],
    }),
  ),
  {
    note: 'no shell window: the card has no parent and nothing is broadcast',
    views: [DIALOG],
    hosts: shown('available'),
    calls: [call('update:get-state', 2)],
  },
  {
    note: 'the shell window may not press the dialog buttons, the dialog may not open Settings',
    views,
    hosts: shown('available'),
    calls: [call('update:download', 1), call('update:open-for-update', 2)],
  },
]

export const group: Group = {
  batch: 'U',
  async load(cx) {
    const { electron } = cx
    const fake = electron.BrowserWindow as Record<string, (...a: unknown[]) => unknown>
    const updateView = (cx.case.views ?? []).find((v) => v.surface === 'ShellUpdate')
    const main = (cx.case.views ?? [SHELL]).find((v) => (v.surface ?? 'Shell') === 'Shell')
    const log = (line: unknown[]) => electron.log.push(line)
    class FakeBrowserWindow {
      static getAllWindows = fake.getAllWindows
      static fromWebContents = fake.fromWebContents
      static fromId = fake.fromId
      static getFocusedWindow = fake.getFocusedWindow
      id: number
      webContents: unknown
      constructor(options: {
        width: number
        height: number
        parent?: { id: number }
        title: string
      }) {
        this.id = updateView?.window ?? 900
        this.webContents = updateView ? electron.contents(updateView.view) : { send() {} }
        log([
          'updateWindow.create',
          {
            width: options.width,
            height: options.height,
            parent: options.parent?.id ?? null,
            title: options.title,
          },
        ])
      }
      once(event: string, fn: () => void) {
        if (event === 'ready-to-show') fn()
      }
      on() {}
      isDestroyed() {
        return false
      }
      show() {
        log(['updateWindow.show', this.id, false])
      }
      showInactive() {
        log(['updateWindow.show', this.id, true])
      }
      focus() {}
      close() {
        log(['updateWindow.close', this.id])
      }
      loadURL() {}
      loadFile() {}
    }
    Object.assign(electron, { BrowserWindow: FakeBrowserWindow })
    useElectron(electron)

    const mod = await cx.fresh<UpdateWindow>(MODULE)
    const parent = () => (main ? (fake.fromId(main.window ?? main.view) as never) : null)
    mod.setUpdateParentWindow(parent)
    // the updater's callbacks return nothing, so the dialog's invokes answer undefined
    const action = (name: string) => (): void => {
      log(['update.action', name])
    }
    const actions = {
      onDownload: action('download'),
      onInstall: action('install'),
      onLater: action('later'),
      onOpenDownload: action('openDownload'),
    }
    const u = (cx.case.hosts?.u ?? {}) as {
      update?: { state: Record<string, unknown>; inactive?: boolean }[]
    }
    for (const { state: s, inactive } of u.update ?? []) {
      const ui = { ...s, releaseNotes: normalizeReleaseNotes(s.releaseNotes) }
      mod.showUpdateWindow(parent(), ui as never, actions, { inactive: inactive ?? false })
    }
  },
  cases,
}
