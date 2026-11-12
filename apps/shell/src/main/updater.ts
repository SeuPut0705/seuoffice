import { dirname, join } from 'node:path'
import { app, dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import { installResumeDownload } from './update-resume'
import {
  clearInstallAttempt,
  installDidNotApply,
  installDirWritable,
  installFailureLevel,
  nextAttemptTries,
  readInstallAttempt,
  recordInstallAttempt,
} from './update-attempt'
import type { InstallFailureLevel } from './update-attempt'
import { createUpdateLog, createUpdateSteps, fileBytes, UPDATE_LOG_FILE } from './update-log'
import { pruneUpdateCache } from './update-cache'
import {
  installMacStaging,
  macAppBundle,
  macSelfUpdateBlock,
  removeMacLeftovers,
  stageMacUpdate,
  startMacSwap,
} from './mac-update'
import type { UpdateLogger, UpdateStep, UpdateStepFields } from './update-log'
import { reopenedByInstaller, requestUpdateRestart, updateRestartRequested } from './update-restart'
import type { UpdateInfo } from 'electron-updater'
import { createI18n, getUiLang, htmlLang } from '@genoffice/i18n'
import { GITHUB_LATEST_RELEASE_URL, githubReleaseTagUrl } from '@genoffice/electron-utils'
import type {
  UpdatePhase,
  UpdateReleaseNotes,
  UpdateUiState,
  UpdateUiStrings,
} from '../shared/update-api'
import { packagedUpdateChannel, type BuildUpdateChannel } from './update-build-channel'
import {
  closeUpdateWindow,
  isUpdateWindowOpen,
  pushUpdateState,
  setUpdateParentWindow,
  showUpdateWindow,
} from './update-window'
import { normalizeReleaseNotes } from './update-notes'

/**
 * Auto-update from the GitHub Releases of the product's public repository,
 * downloading only the changed blocks when it can (see below).
 *
 * A release carries the versioned installer and its `latest.yml`
 * (docs/archive/ieum/releasing.ko.md is the procedure). The packaged app reads the
 * repository from resources/app-update.yml, which electron-builder bakes in
 * from the `publish` config in apps/shell/electron-builder.cjs (provider
 * `github`); nothing is injected at build time and no token is involved. A
 * repository without any release, an unreachable network, or any other
 * failed check is passed over quietly: nothing is shown and the next check
 * runs as scheduled.
 *
 * UX is the strong-guidance modal card (update-window.ts), not a native
 * dialog. Windows updates through the NSIS installer (latest.yml); macOS
 * downloads the zip target named in latest-mac.yml and installs it itself
 * (mac-update.ts); Linux through the AppImage
 * target (latest-linux.yml). On Linux only AppImage runs self-update
 * (electron-updater replaces the .AppImage file in place, no root needed);
 * deb installs have no updater — users upgrade via `apt install ./<new>.deb`.
 *
 * Dev preview: GENOFFICE_FAKE_UPDATE=<version> in an unpacked run opens the
 * window with a simulated download so the UI can be exercised end to end.
 */

const tUpd = createI18n({
  en: {
    updTitle: 'Software Update',
    updHeadline: 'A new version is available',
    updDesc:
      'This update includes performance improvements and bug fixes. We recommend updating now.',
    updDownload: 'Update Now',
    updLater: 'Minimize',
    updInstall: 'Restart & Install',
    updDownloading: 'Downloading update…',
    updFailed: 'Update download failed. Check your network and try again.',
    updRetry: 'Retry',
    updManual:
      'Automatic update failed. Please get the latest version from the download page and install it manually.',
    updUpToDate: "You're up to date (version {version}).",
    updCheckFailed: "Couldn't check for updates. Check your network and try again.",
    updOpenDownload: 'Open Download Page',
    updNotesLabel: "What's new",
    updNotesOnGitHub: 'View full notes on GitHub',
    updNotesTruncated: 'Only part of the notes is shown.',
    updManualMac:
      "This Mac can't install the update automatically. Download the new version from the download page and put it in the Applications folder. If you opened the app straight from the disk image, move it to Applications and later updates install by themselves.",
    updInstallFailed:
      'The last update did not install. This time the installer opens in its own window so you can see its progress.',
    updVisibleInstall:
      'After the restart an installer window shows the progress. If Windows asks for administrator approval, choose Yes. When it finishes, the app and the documents you had open come back.',
    updRestartNote:
      'After the restart an installer window shows the progress. When it finishes, the app and the documents you had open come back.',
    updRestartNoteMac:
      'The app closes, is replaced with the new version and opens again, along with the documents you had open.',
  },
  ko: {
    updTitle: '소프트웨어 업데이트',
    updHeadline: '새 버전이 있습니다',
    updDesc:
      '이 업데이트에는 성능 개선과 버그 수정이 포함되어 있습니다. 지금 업데이트하는 것을 권장합니다.',
    updDownload: '지금 업데이트',
    updLater: '최소화',
    updInstall: '다시 시작 및 설치',
    updDownloading: '업데이트 다운로드 중…',
    updFailed: '업데이트 다운로드에 실패했습니다. 네트워크를 확인한 후 다시 시도하세요.',
    updRetry: '다시 시도',
    updManual:
      '자동 업데이트에 실패했습니다. 다운로드 페이지에서 최신 버전을 받아 직접 설치해 주세요.',
    updUpToDate: '최신 버전입니다 (버전 {version}).',
    updCheckFailed: '업데이트를 확인할 수 없습니다. 네트워크를 확인한 후 다시 시도하세요.',
    updOpenDownload: '다운로드 페이지 열기',
    updNotesLabel: '업데이트 내용',
    updNotesOnGitHub: 'GitHub에서 전체 보기',
    updNotesTruncated: '일부만 표시했습니다.',
    updManualMac:
      '이 Mac에서는 업데이트를 자동으로 설치할 수 없습니다. 다운로드 페이지에서 새 버전을 받아 응용 프로그램 폴더에 넣어 주세요. 디스크 이미지에서 앱을 바로 열었다면 응용 프로그램 폴더로 옮겨 두세요. 다음 업데이트부터는 저절로 설치됩니다.',
    updInstallFailed:
      '지난번 업데이트가 설치되지 않았습니다. 이번에는 설치 프로그램을 창으로 띄워 진행 상황을 보여 드립니다.',
    updVisibleInstall:
      "다시 시작하면 설치 진행 창이 뜹니다. 관리자 승인을 묻는 창이 나오면 '예'를 눌러 주세요. 설치가 끝나면 앱과 열려 있던 문서가 다시 열립니다.",
    updRestartNote:
      '다시 시작하면 설치 진행 창이 뜹니다. 설치가 끝나면 앱과 열려 있던 문서가 다시 열립니다.',
    updRestartNoteMac:
      '앱이 닫히고 새 버전으로 바뀐 뒤 다시 열립니다. 열어 두었던 문서도 다시 열립니다.',
  },
})

const FIRST_CHECK_DELAY_MS = 15_000
// hourly: the latest channel gets a release for every green push to main
const RECHECK_INTERVAL_MS = 60 * 60 * 1000
// a cache file the installer still held at the start: tried again this often,
// this many times (the installer ends seconds after the app is back)
const CACHE_RETRY_DELAY_MS = 30_000
const CACHE_RETRIES = 4

// After this many failed download/apply attempts for the same version the
// dialog stops offering "retry" and guides the user to a manual download
// instead. Covers permanently broken update paths — most importantly a
// code-signing identity (Apple Team ID) change, which Squirrel.Mac rejects
// on every retry while the error looks like a download failure to the user.
const MANUAL_FALLBACK_AFTER = 2
// Where a manual install starts: the repository's own release pages, never a
// URL taken from remotely fetched update metadata. The offered version's own
// page: on the latest channel it may be a pre-release, which GitHub's
// "Latest" page does not show.
function manualDownloadUrlFor(version: string | null): string {
  return version !== null ? githubReleaseTagUrl(version) : GITHUB_LATEST_RELEASE_URL
}

// electron-updater error codes that mean "the repository has nothing to offer
// this install" rather than "the check could not run": an empty release list
// (ERR_XML_MISSED_ELEMENT — what GitHub serves before the first release), no
// full release for "latest" to resolve to, a release without this platform's
// feed file, or a 404 for the list itself.
const NO_RELEASE_ERROR_CODES = new Set([
  'ERR_XML_MISSED_ELEMENT',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  'ERR_UPDATER_INVALID_RELEASE_FEED',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'HTTP_ERROR_404',
])

function isNoReleaseError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && NO_RELEASE_ERROR_CODES.has(code)
}

let started = false
// version the user declined this session — don't nag again until next launch
let dismissedVersion: string | null = null
// re-shows the GENOFFICE_FAKE_UPDATE window so the manual check is
// exercisable in dev runs too
let fakeShowAgain: (() => void) | null = null
let manualCheckInFlight = false
// true once the packaged-run updater is configured; a manual check before
// that (or in dev runs) must not touch electron-updater
let updaterActive = false

// the update record in the data folder, once the packaged updater is set up
let updateLog: UpdateLogger | null = null

function log(...args: unknown[]): void {
  console.log('[updater]', ...args)
  updateLog?.info(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
}

/** marks a step of the update in the record (update-log.ts); a no-op until the updater runs */
let step: (step: UpdateStep, fields?: UpdateStepFields) => void = () => {}

function uiStrings(): UpdateUiStrings {
  const lang = getUiLang()
  return {
    title: tUpd(lang, 'updTitle'),
    headline: tUpd(lang, 'updHeadline'),
    desc: tUpd(lang, 'updDesc'),
    download: tUpd(lang, 'updDownload'),
    later: tUpd(lang, 'updLater'),
    install: tUpd(lang, 'updInstall'),
    downloading: tUpd(lang, 'updDownloading'),
    failed: tUpd(lang, 'updFailed'),
    retry: tUpd(lang, 'updRetry'),
    manualDesc: tUpd(lang, process.platform === 'darwin' ? 'updManualMac' : 'updManual'),
    installFailedDesc: tUpd(lang, 'updInstallFailed'),
    visibleInstallDesc: tUpd(lang, 'updVisibleInstall'),
    // Windows hands over to an installer window, macOS to the swap
    // (mac-update.ts); both reopen the app
    restartDesc:
      process.platform === 'win32'
        ? tUpd(lang, 'updRestartNote')
        : process.platform === 'darwin'
          ? tUpd(lang, 'updRestartNoteMac')
          : '',
    openDownload: tUpd(lang, 'updOpenDownload'),
    notesLabel: tUpd(lang, 'updNotesLabel'),
    notesOnGitHub: tUpd(lang, 'updNotesOnGitHub'),
    notesTruncated: tUpd(lang, 'updNotesTruncated'),
  }
}

function initialState(
  version: string,
  releaseNotes: UpdateReleaseNotes | null = null,
  visibleInstall = false,
): UpdateUiState {
  return {
    phase: 'available',
    version,
    currentVersion: app.getVersion(),
    percent: 0,
    lang: htmlLang(getUiLang()),
    strings: uiStrings(),
    releaseNotes,
    visibleInstall,
  }
}

// The build's channel (update-build-channel.ts) decides which releases count.
// latest: the newest release in the feed, a pre-release too, through its
// latest.yml. electron-updater's pre-release search only takes the first
// entry while its own channel is unset, so it stays unset here.
// stable: GitHub's Latest release only (allowPrerelease off), through the
// stable.yml the stable build attaches to every release.
function selectChannel(channel: BuildUpdateChannel): void {
  if (channel === 'stable') autoUpdater.channel = 'stable'
  // the channel setter unconditionally flips allowDowngrade to true; force it
  // back off: an update never installs an older version
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = channel === 'latest'
}

/** User-triggered check (☰ > Check for Updates…, Help on macOS, or the About
 * dialog button).
 * Unlike the silent launch/periodic checks, every outcome gets explicit
 * feedback: an available update opens the standard update window (even a
 * version dismissed with "later" this session — the user just asked for it),
 * up-to-date and failure each get a dialog (a repository with no release to
 * offer counts as up-to-date, not as a failure), and installs with no
 * self-update mechanism (dev runs, Linux .deb) are pointed at the download
 * page instead of being told they're current. */
export async function checkForUpdatesNow(): Promise<void> {
  if (manualCheckInFlight) return
  manualCheckInFlight = true
  try {
    const lang = getUiLang()
    if (fakeShowAgain) {
      fakeShowAgain()
      return
    }
    if (!updaterActive) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: tUpd(lang, 'updTitle'),
        message: tUpd(lang, 'updManual'),
        buttons: ['OK', tUpd(lang, 'updOpenDownload')],
        defaultId: 0,
        cancelId: 0,
      })
      if (response === 1) void shell.openExternal(GITHUB_LATEST_RELEASE_URL)
      return
    }
    dismissedVersion = null
    let result
    try {
      step('check-start', { by: 'user' })
      result = await autoUpdater.checkForUpdates()
      step('check-end', { found: result?.isUpdateAvailable ? result.updateInfo?.version : 'none' })
      if (result === null) throw new Error('Update check was skipped')
    } catch (err) {
      if (!result) step('check-end', { found: 'failed' })
      log('manual check failed:', (err as Error)?.message ?? err)
      if (!isNoReleaseError(err)) {
        await dialog.showMessageBox({
          type: 'warning',
          title: tUpd(lang, 'updTitle'),
          message: tUpd(lang, 'updCheckFailed'),
          buttons: ['OK'],
          defaultId: 0,
          cancelId: 0,
        })
        return
      }
    }
    // an available update already opened the update window via the
    // 'update-available' handler; only "nothing new" needs a dialog here
    if (result?.isUpdateAvailable) return
    await dialog.showMessageBox({
      type: 'info',
      title: tUpd(lang, 'updTitle'),
      message: tUpd(lang, 'updUpToDate', { version: app.getVersion() }),
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
    })
  } finally {
    manualCheckInFlight = false
  }
}

export function initAutoUpdater(
  getWindow: () => BrowserWindow | null,
  /** Settings › "Check for updates automatically"; read at every background check (genoffice#2127) */
  autoCheckEnabled: () => boolean = () => true,
  /** fixed at packaging time; a parameter so tests can pick it */
  channel: BuildUpdateChannel = packagedUpdateChannel(),
): void {
  if (started) return
  started = true
  setUpdateParentWindow(getWindow)

  // dev preview of the update window with a simulated download
  if (!app.isPackaged && process.env.GENOFFICE_FAKE_UPDATE) {
    initFakeUpdate(getWindow, process.env.GENOFFICE_FAKE_UPDATE)
    return
  }
  // Unpacked runs have no app-update.yml and must not ask GitHub with a
  // dev version. Windows updates via NSIS (latest.yml), macOS via the zip
  // target + latest-mac.yml (installed by mac-update.ts, not Squirrel.Mac —
  // dmg is first-install only), Linux via the AppImage target +
  // latest-linux.yml. On Linux the updater only works for AppImage runs
  // (electron-updater's AppImageUpdater needs the APPIMAGE env var the
  // AppImage runtime sets); deb installs update manually via apt.
  if (!app.isPackaged) return
  const isLinuxAppImage = process.platform === 'linux' && Boolean(process.env.APPIMAGE)
  if (process.platform !== 'win32' && process.platform !== 'darwin' && !isLinuxAppImage) return

  updaterActive = true
  const dataDir = app.getPath('userData')
  const record = createUpdateLog(join(dataDir, UPDATE_LOG_FILE))
  updateLog = record
  autoUpdater.logger = record
  step = createUpdateSteps((line) => log(line))
  // the installer passes --updated when it reopens the app after an update;
  // without it this launch was the user's own
  const launchedBy = reopenedByInstaller() ? ', reopened by the installer' : ''
  log('running', app.getVersion(), 'on the', channel, `channel${launchedBy}`)
  selectChannel(channel)
  autoUpdater.autoDownload = false
  // The window shows what changed before the user starts the download
  // (docs/archive/ieum/plans/update-details.md). The full changelog collects the bodies of
  // every release newer than this install from the feed request the GitHub
  // provider already makes — no extra network call.
  autoUpdater.fullChangelog = true
  // The installer is started here at will-quit (startInstaller below), never
  // by electron-updater's own quit hook: the quit is certain by then, so the
  // installer cannot close the app over a save prompt, and every start is
  // recorded for the next launch to check.
  autoUpdater.autoInstallOnAppQuit = false
  // Differential download: only the blocks that changed since the running
  // version (about 9% of the Windows installer and 18% of the Mac zip between
  // two releases a day apart). It needs the running version's file and the
  // .blockmap of both releases: Windows, the copy the installer keeps of
  // itself (`installer.exe` in the update cache, update-cache.ts keeps it);
  // Mac, the `update.zip` electron-updater keeps after each download. When
  // any of it is missing (the first update, a pruned old release) or the
  // result fails the feed's sha512, electron-updater downloads the whole
  // file instead (tests/update-differential.test.ts).
  autoUpdater.disableDifferentialDownload = false
  installResumeDownload(autoUpdater as unknown as Parameters<typeof installResumeDownload>[0])

  // macOS: Squirrel.Mac only installs into an app signed with a Developer ID,
  // which this product's Mac builds do not have (decision 0031). The app
  // installs the downloaded zip itself (mac-update.ts, decision 0097); an
  // install that cannot replace itself keeps the download page.
  const isMac = process.platform === 'darwin'
  const macBundle = isMac ? macAppBundle(process.execPath) : null
  // bytes the running download has fetched so far (its progress events); less
  // than the file when only the changed blocks were downloaded
  let transferred: number | null = null
  // the unpacked new version, once a download for it has been checked
  let macStaged: { version: string; app: string } | null = null
  let selfUpdates = true
  if (isMac) {
    const block = macSelfUpdateBlock(process.execPath)
    if (macBundle !== null && block === null) removeMacLeftovers(macBundle)
    const staging =
      macBundle !== null &&
      block === null &&
      installMacStaging(autoUpdater, async (zip, version) => {
        macStaged = null
        step('download-end', { version, bytes: fileBytes(zip), transferred })
        log('unpacking', version, 'beside', macBundle)
        const stagedApp = await stageMacUpdate({ zip, bundle: macBundle, version, step })
        macStaged = { version, app: stagedApp }
        log('unpacked and checked', version)
      })
    selfUpdates = staging
    if (!staging) log('this Mac install cannot update itself:', block ?? 'no staging hook')
  }

  let latestSeenVersion: string | null = null
  // release notes of latestSeenVersion, converted once when the version lands
  let latestSeenNotes: UpdateReleaseNotes | null = null
  // consecutive failed attempts for latestSeenVersion. Every failed download
  // rejects downloadUpdate() (electron-updater also emits 'error' for it, as
  // it does for a failed check, so 'error' alone says nothing about the
  // download); the in-flight flag keeps a late rejection from counting twice
  let failedAttempts = 0
  let downloadInFlight = false
  // where latestSeenVersion got to, so re-opening the window for the same
  // version (a manual check after "later") resumes there instead of offering
  // "Update Now" over a download that is running or already finished
  let phase: UpdatePhase = 'available'
  let percent = 0
  // the running download's token plus a generation stamp, so a channel switch
  // can cancel the request and its late rejection cannot fail the next one
  let downloadToken: CancellationToken | null = null
  let downloadGen = 0

  // An installer start that left the app at the old version is reported and
  // gets one more try; a second one that failed goes to the download page
  // (update-attempt.ts). A record with nothing left to say goes.
  const previousAttempt = readInstallAttempt(dataDir)
  const failedInstall = installDidNotApply(previousAttempt, app.getVersion())
    ? previousAttempt
    : null
  const installFailures: InstallFailureLevel = installFailureLevel(failedInstall)
  if (failedInstall) {
    log(
      'the installer started for',
      failedInstall.version,
      failedInstall.visible ? 'in its own window' : 'silently',
      'did not update',
      app.getVersion(),
    )
  } else if (previousAttempt) {
    log('the installer started for', previousAttempt.version, 'has run; now', app.getVersion())
    const since = previousAttempt.startedAt ? Date.parse(previousAttempt.startedAt) : NaN
    step('app-started', {
      version: app.getVersion(),
      from: previousAttempt.fromVersion,
      // from the installer's (or swap's) start to this line; the app's own
      // start-up up to here is `uptime-s`
      'since-install-start-s': Number.isNaN(since)
        ? null
        : ((Date.now() - since) / 1000).toFixed(1),
      'uptime-s': process.uptime().toFixed(1),
    })
    clearInstallAttempt(dataDir)
  }

  // An "all users" install needs administrator rights, so its installer window
  // will ask for them; the update window says so before the restart. Checked once.
  let installDirOk: boolean | null = null
  const adminPromptExpected = (): boolean => {
    if (process.platform !== 'win32') return false
    installDirOk ??= installDirWritable(
      dirname(process.execPath),
      `.ieumoffice-update-check-${process.pid}`,
    )
    return !installDirOk
  }

  // macOS: the swap starts once the app's process is gone and reopens the
  // app, the new version when it worked. The next launch reads the record
  // like it does after the Windows installer.
  const startMacSwapFor = (version: string): void => {
    if (macBundle === null || macStaged === null || macStaged.version !== version) {
      log('no unpacked update for', version, 'to install')
      return
    }
    const tries = nextAttemptTries(failedInstall, version)
    recordInstallAttempt(dataDir, {
      version,
      fromVersion: app.getVersion(),
      visible: false,
      tries,
      startedAt: new Date().toISOString(),
    })
    step('swap-scheduled', { version })
    log('replacing the app with', version, 'once it has quit, try', String(tries))
    const started = startMacSwap({
      pid: process.pid,
      bundle: macBundle,
      staged: macStaged.app,
      logFile: join(dataDir, UPDATE_LOG_FILE),
    })
    if (!started) log('the swap did not start')
  }

  const startInstaller = (version: string): void => {
    // Windows: the installer's own window, progress page only, which reopens
    // the app at the end (build/installer.nsh). A silent install left the user
    // a minute or more of nothing, long enough to start the app again into
    // the files being replaced (decision 0077).
    const visible = process.platform === 'win32'
    const tries = nextAttemptTries(failedInstall, version)
    recordInstallAttempt(dataDir, {
      version,
      fromVersion: app.getVersion(),
      visible,
      tries,
      startedAt: new Date().toISOString(),
    })
    step('installer-start', { version })
    log(
      'starting the installer for',
      version,
      visible ? 'in its own window' : 'silently',
      'to reopen the app, try',
      String(tries),
    )
    // BaseUpdater.install: the same call electron-updater's quit hook makes;
    // it spawns the installer detached and returns at once
    const updater = autoUpdater as unknown as {
      install?: (isSilent: boolean, isForceRunAfter: boolean) => boolean
    }
    if (typeof updater.install !== 'function' || !updater.install(!visible, true)) {
      log('the installer did not start')
    }
  }

  // will-quit comes only once every window has closed and no save prompt was
  // cancelled: the right moment to hand over to the installer. Only "Restart &
  // Install" installs. An ordinary quit never does: the user would not know an
  // install is running and could open the app into it (decision 0077).
  app.on('will-quit', () => {
    if (!selfUpdates || phase !== 'downloaded' || latestSeenVersion === null) return
    if (!updateRestartRequested()) return
    step('will-quit', { version: latestSeenVersion })
    if (isMac) startMacSwapFor(latestSeenVersion)
    else startInstaller(latestSeenVersion)
  })

  const setPhase = (patch: {
    phase: UpdatePhase
    percent?: number
    visibleInstall?: boolean
  }): void => {
    phase = patch.phase
    if (patch.percent !== undefined) percent = patch.percent
    pushUpdateState(patch)
  }

  /** the window state for `version` at the current phase */
  const windowState = (version: string): UpdateUiState => ({
    ...initialState(version, latestSeenNotes, phase === 'downloaded' && adminPromptExpected()),
    phase,
    percent,
  })

  const failDownload = (): void => {
    if (!downloadInFlight) return
    downloadInFlight = false
    step('download-end', { failed: 'yes', transferred })
    failedAttempts += 1
    setPhase({ phase: failedAttempts >= MANUAL_FALLBACK_AFTER ? 'manual' : 'error' })
  }

  const actions = {
    onDownload: () => {
      if (phase === 'downloading' || phase === 'downloaded') return
      if (!selfUpdates) {
        void shell.openExternal(manualDownloadUrlFor(latestSeenVersion))
        return
      }
      downloadInFlight = true
      transferred = null
      step('download-start', { version: latestSeenVersion })
      setPhase({ phase: 'downloading', percent: 0 })
      const gen = ++downloadGen
      downloadToken = new CancellationToken()
      autoUpdater.downloadUpdate(downloadToken).catch((err) => {
        if (gen !== downloadGen) return
        log('download failed:', err?.message ?? err)
        failDownload()
      })
    },
    onInstall: () => {
      closeUpdateWindow()
      if (latestSeenVersion === null || phase !== 'downloaded') return
      step('quit-requested', { version: latestSeenVersion })
      requestUpdateRestart()
      // let the window fully close before tearing the app down; the installer
      // starts at will-quit, after every save prompt has been answered
      setImmediate(() => app.quit())
    },
    onLater: () => {
      dismissedVersion = latestSeenVersion
      closeUpdateWindow()
    },
    onOpenDownload: () => {
      void shell.openExternal(manualDownloadUrlFor(latestSeenVersion))
    },
  }

  autoUpdater.on('error', (err) => {
    // network failures during background checks are expected and shown
    // nowhere; a failed download is reported by its own rejection (onDownload)
    log('error:', err?.message ?? err)
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (info.version === dismissedVersion) return
    const sameVersionRecheck = info.version === latestSeenVersion
    // progress/downloaded/error events carry no version, so a newer release
    // landing while the previous one is downloading or already downloaded
    // stays out until that flow ends (it installs on quit and the next launch
    // picks up the newer one); it must not hijack the open window
    if (!sameVersionRecheck && (downloadInFlight || phase === 'downloaded')) {
      log('update available:', info.version, 'ignored while', latestSeenVersion, 'is', phase)
      // an explicit check still owes feedback: bring back the flow in progress
      // (a background recheck stays quiet)
      if (manualCheckInFlight && !isUpdateWindowOpen()) {
        showUpdateWindow(getWindow(), windowState(latestSeenVersion ?? info.version), actions)
      }
      return
    }
    if (!sameVersionRecheck) {
      failedAttempts = 0
      // a Mac swap that did not take is not retried: nothing about it would
      // change on a second try (the install-failed wording is the Windows
      // installer's)
      phase =
        !selfUpdates || installFailures >= 2 || (isMac && installFailures >= 1)
          ? 'manual'
          : installFailures === 1
            ? 'install-failed'
            : 'available'
      percent = 0
      latestSeenNotes = normalizeReleaseNotes(info.releaseNotes)
    } else {
      // a repeated event for the same version (periodic recheck) refreshes
      // the notes only when the feed carried some — never wipe already known
      // notes with a notes-less repeat
      latestSeenNotes = normalizeReleaseNotes(info.releaseNotes) ?? latestSeenNotes
    }
    latestSeenVersion = info.version
    log('update available:', info.version)
    // a periodic recheck resolving to the version the open dialog already
    // shows must not reset its phase to 'available' — that would wipe an
    // in-progress download or a terminal 'manual' fallback back to the
    // "Update Now" offer
    if (sameVersionRecheck && isUpdateWindowOpen()) return
    showUpdateWindow(getWindow(), windowState(info.version), actions)
  })

  autoUpdater.on('download-progress', (progress) => {
    if (!downloadInFlight) return
    transferred = progress.transferred
    setPhase({ phase: 'downloading', percent: progress.percent })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo & { downloadedFile?: string }) => {
    if (info.version !== latestSeenVersion) {
      log('downloaded:', info.version, 'ignored (stale after channel switch)')
      return
    }
    // the Mac download ended where its zip was handed over to be unpacked
    if (!isMac) {
      step('download-end', {
        version: info.version,
        bytes: fileBytes(info.downloadedFile),
        transferred,
      })
    }
    log('downloaded:', info.version)
    downloadInFlight = false
    failedAttempts = 0
    setPhase({ phase: 'downloaded', percent: 100, visibleInstall: adminPromptExpected() })
    // A download finished behind a minimized window would otherwise wait,
    // unseen, in Settings > About: bring "Restart & Install" back, without
    // taking the focus from whatever the user is typing in.
    if (!isUpdateWindowOpen()) {
      showUpdateWindow(getWindow(), windowState(info.version), actions, { inactive: true })
    }
  })

  // What the last update left in electron-updater's download cache goes at a
  // start (update-cache.ts). The folder is the updater's to name (it reads
  // the name from app-update.yml); nothing is removed once a download runs
  // or a finished one waits for the restart. The installer that reopened the
  // app outlives it by seconds and holds its own file meanwhile, so a removal
  // that failed is tried again a little later, a few times.
  // AppUpdater.getOrCreateDownloadHelper is private in its typings; what it
  // answers is checked before use, like `install` above
  const cacheOwner = autoUpdater as unknown as {
    getOrCreateDownloadHelper?: () => Promise<{ cacheDir?: unknown } | null>
  }
  const clearInstalledCache = async (triesLeft: number): Promise<void> => {
    try {
      const helper = await cacheOwner.getOrCreateDownloadHelper?.()
      if (typeof helper?.cacheDir !== 'string') {
        log('the update cache was not looked at: the updater names no cache folder')
        return
      }
      if (downloadInFlight || phase === 'downloaded') return
      const cleared = pruneUpdateCache({
        cacheDir: helper.cacheDir,
        runningVersion: app.getVersion(),
        log,
      })
      if (!cleared && triesLeft > 0) {
        setTimeout(() => void clearInstalledCache(triesLeft - 1), CACHE_RETRY_DELAY_MS)
      }
    } catch (err) {
      log('the update cache was not looked at:', err instanceof Error ? err.message : String(err))
    }
  }
  void clearInstalledCache(CACHE_RETRIES)

  const check = (): void => {
    // turned off: only an explicit check (Help › Check for Updates…, a channel switch) asks the feed
    if (!autoCheckEnabled()) return
    // a newer release found now would wait anyway (update-available above),
    // and the request only competes with the download for the network
    if (downloadInFlight || phase === 'downloaded') return
    step('check-start', { by: 'schedule' })
    autoUpdater
      .checkForUpdates()
      .then((result) =>
        step('check-end', {
          found: result?.isUpdateAvailable ? result.updateInfo?.version : 'none',
        }),
      )
      .catch((err) => {
        step('check-end', { found: 'failed' })
        log('check failed:', err?.message ?? err)
      })
  }
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, RECHECK_INTERVAL_MS)
}

/** unpacked-run simulation: real window + IPC, fake download that completes */
function initFakeUpdate(getWindow: () => BrowserWindow | null, version: string): void {
  let timer: NodeJS.Timeout | null = null
  const actions = {
    onDownload: () => {
      let pct = 0
      pushUpdateState({ phase: 'downloading', percent: 0 })
      timer = setInterval(() => {
        pct += 4
        if (pct >= 100) {
          if (timer) clearInterval(timer)
          pushUpdateState({ phase: 'downloaded', percent: 100 })
        } else {
          pushUpdateState({ phase: 'downloading', percent: pct })
        }
      }, 100)
    },
    onInstall: () => {
      log('[fake] install requested')
      closeUpdateWindow()
    },
    onLater: () => {
      if (timer) clearInterval(timer)
      closeUpdateWindow()
    },
    onOpenDownload: () => {
      log('[fake] open download page requested')
    },
  }
  // two sections show the skipped-versions layout (per-version headings)
  const notes = normalizeReleaseNotes([
    {
      version,
      note: `<p>A simulated update for the preview.</p>
<h2>What's new</h2>
<ul>
<li><strong>Update notes</strong>: the window shows what changed before you update.</li>
<li><code>GENOFFICE_FAKE_UPDATE</code> opens this preview.</li>
</ul>`,
    },
    {
      version: '9.9.8',
      note: `<p>Notes of the previous version.</p>
<h2>Fixed</h2>
<ul>
<li>One older fix, shown when versions were skipped.</li>
</ul>`,
    },
  ])
  fakeShowAgain = () => showUpdateWindow(getWindow(), initialState(version, notes), actions)
  setTimeout(() => fakeShowAgain?.(), 1500)
}
