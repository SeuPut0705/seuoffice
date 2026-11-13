/**
 * Group `w/quick-look`: Quick Look's home-side settings
 * (`apps/shell/src/main/quick-look/quick-look-window.ts`), configured as
 * `apps/shell/src/main/index.ts` configures it: the settings live under
 * `quickLook` in userData/app-settings.json. The Explorer hook and the tray
 * are Windows-only (`syncQuickLookRuntime` does nothing elsewhere).
 */
import { join } from 'node:path'
import { readAppSettings, writeAppSetting } from '../../../../apps/shell/src/main/app-settings.ts'
import { normalizeQuickLookSettings } from '../../../../apps/shell/src/shared/quick-look-home.ts'
import type { Case, Group } from '../../types.ts'

const MODULE = 'apps/shell/src/main/quick-look/quick-look-window.ts'
type QuickLookWindow =
  typeof import('../../../../apps/shell/src/main/quick-look/quick-look-window.ts')

const get = { channel: 'quick-look:get-settings', args: [] }
const set = (partial: unknown) => ({ channel: 'quick-look:set-settings', args: [partial] })
const saved = (quickLook: unknown) => ({
  'userData/app-settings.json': JSON.stringify({ lang: 'ko', quickLook }),
})

const cases: Case[] = [
  { note: 'no settings file: the defaults', calls: [get] },
  {
    note: 'saved settings',
    files: saved({ explorerSpacePreview: false, keepInTray: true }),
    calls: [get],
  },
  {
    note: 'a saved value of the wrong type falls back',
    files: saved({ explorerSpacePreview: 'no' }),
    calls: [get],
  },
  {
    note: 'a corrupt file reads as empty',
    files: { 'userData/app-settings.json': '{oops' },
    calls: [get],
  },
  {
    note: 'set one flag, keep the other, then read back',
    files: { 'userData/app-settings.json': '{"lang":"en"}' },
    calls: [set({ keepInTray: true }), get],
  },
  {
    note: 'set the other flag: the saved one stays',
    files: saved({ explorerSpacePreview: false, keepInTray: true }),
    calls: [set({ explorerSpacePreview: true })],
  },
  {
    note: 'set both on a missing file',
    files: { userData: { dir: true } },
    calls: [set({ explorerSpacePreview: false, keepInTray: true })],
  },
  {
    note: 'a non-boolean flag is ignored',
    files: { userData: { dir: true } },
    calls: [set({ keepInTray: 'yes', explorerSpacePreview: 0 })],
  },
  {
    note: 'null and a string are not objects',
    files: { userData: { dir: true } },
    calls: [set(null), set('x')],
  },
  {
    note: 'no argument at all',
    files: { userData: { dir: true } },
    calls: [{ channel: 'quick-look:set-settings', args: [] }],
  },
  {
    note: 'the folder is missing: the write fails',
    calls: [set({ keepInTray: true })],
  },
  {
    note: 'a view the channel is not open to is refused',
    views: [{ view: 2, surface: 'ShellQuickLook' }],
    calls: [get],
  },
]

export const group: Group = {
  batch: 'W',
  async load(cx) {
    const settingsPath = join(cx.dir, 'userData', 'app-settings.json')
    const mod = await cx.fresh<QuickLookWindow>(MODULE)
    mod.configureQuickLookWindow({
      parentWindow: () => null,
      lang: () => 'ko',
      theme: () => 'light',
      trayIcon: () => null,
      readSettings: () => normalizeQuickLookSettings(readAppSettings(settingsPath).quickLook),
      writeSettings: (next) => writeAppSetting(settingsPath, 'quickLook', next),
      openInEditor: () => {},
      showShellWindow: () => {},
      quitApp: () => {},
    })
  },
  cases,
}
