import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { createI18n, getUiLang } from '@genoffice/i18n'

/**
 * Full-package auto-update for the standalone GenOffice Docs app.
 *
 * electron-builder bakes the publish config into resources/app-update.yml at
 * package time and emits the update feed (latest.yml on Windows,
 * latest-mac.yml on macOS) next to the installers; a release publishes both.
 * Standalone docs builds currently ship without a publish config, so packaged
 * runs simply log the missing-feed error. The product itself updates through
 * the shell (apps/shell/src/main/updater.ts) from the GitHub Releases of its
 * repository; like there, a failed check or a feed without any release is
 * passed over quietly.
 *
 * Unlike the shell's modal update window, docs keeps the flow minimal:
 * updates download silently in the background and a single native dialog
 * offers "Restart & Install" once the payload is ready. Declining defers the
 * install to normal app quit (autoInstallOnAppQuit).
 */

const tUpd = createI18n({
  en: {
    updTitle: 'Software Update',
    updHeadline: 'A new version is available',
    updDesc:
      'This update includes performance improvements and bug fixes. We recommend updating now.',
    updInstall: 'Restart & Install',
    updLater: 'Remind me later',
  },
  ko: {
    updTitle: '소프트웨어 업데이트',
    updHeadline: '새 버전이 있습니다',
    updDesc:
      '이 업데이트에는 성능 개선과 버그 수정이 포함되어 있습니다. 지금 업데이트하는 것을 권장합니다.',
    updInstall: '다시 시작 및 설치',
    updLater: '나중에 알림',
  },
})

const FIRST_CHECK_DELAY_MS = 15_000
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let started = false
// version the user declined this session — don't nag again until next launch
let dismissedVersion: string | null = null

function log(...args: unknown[]): void {
  console.log('[docs-updater]', ...args)
}

async function promptInstall(win: BrowserWindow | null, info: UpdateInfo): Promise<void> {
  const lang = getUiLang()
  const options = {
    type: 'info' as const,
    title: tUpd(lang, 'updTitle'),
    message: `${tUpd(lang, 'updHeadline')} (${info.version})`,
    detail: tUpd(lang, 'updDesc'),
    buttons: [tUpd(lang, 'updInstall'), tUpd(lang, 'updLater')],
    defaultId: 0,
    cancelId: 1,
  }
  const { response } =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
  if (response === 0) {
    autoUpdater.quitAndInstall(true, true)
  } else {
    // autoInstallOnAppQuit still applies the update on normal quit
    dismissedVersion = info.version
  }
}

export function initDocsAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (started) return
  started = true

  // Unpacked runs have no app-update.yml and must not ask the feed with a dev
  // version. Windows updates via NSIS (latest.yml); macOS via the zip target
  // (latest-mac.yml) — Squirrel.Mac additionally requires a signed app, so
  // unsigned local builds check but never install.
  if (!app.isPackaged) return
  if (process.platform !== 'win32' && process.platform !== 'darwin') return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // full-package policy: never attempt blockmap differential downloads
  // (the publish pipeline does not upload .blockmap files)
  autoUpdater.disableDifferentialDownload = true

  autoUpdater.on('error', (err) => {
    // background check/download failures are expected offline; log only
    log('error:', err instanceof Error ? err.message : err)
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    if (info.version === dismissedVersion) return
    log('downloaded:', info.version)
    promptInstall(getWindow(), info).catch((err) => {
      log('install prompt failed:', err instanceof Error ? err.message : err)
    })
  })

  const check = (): void => {
    autoUpdater
      .checkForUpdates()
      .catch((err) => log('check failed:', err instanceof Error ? err.message : err))
  }
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, RECHECK_INTERVAL_MS)
}
