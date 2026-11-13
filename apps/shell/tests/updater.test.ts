import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpError } from 'builder-util-runtime'
// deep import on purpose: 'electron-updater' itself is mocked below, the
// provider that talks to GitHub is the dependency's real code
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider'
import {
  GITHUB_LATEST_RELEASE_URL,
  GITHUB_REPO_NAME,
  GITHUB_REPO_OWNER,
  githubReleaseTagUrl,
} from '@seuoffice/electron-utils'
import type { UpdateUiState } from '../src/shared/update-api'

/**
 * Main-process auto-updater flow (src/main/updater.ts): manual-download policy
 * driven by the strong-guidance update window — the renderer's Download /
 * Install / Later actions come back through update-window.ts callbacks.
 *
 * The feed is the GitHub Releases of the product repository. Where a test is
 * about what that feed answers, the mocked `checkForUpdates` runs
 * electron-updater's real GitHubProvider over canned github.com responses, so
 * the errors and the release it picks are the dependency's own.
 */

const appState = { isPackaged: true, dataDir: '', version: '0.1.0' }
const appListeners = new Map<string, () => void>()
const appQuit = vi.hoisted(() => vi.fn())
// whether this user may write into the install folder (an "all users" install
// under Program Files may not)
const installDir = { writable: true }

const openExternal = vi.hoisted(() => vi.fn())
const showMessageBox = vi.hoisted(() =>
  vi.fn<(opts: unknown) => Promise<{ response: number }>>(() => Promise.resolve({ response: 0 })),
)
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged
    },
    getVersion: () => appState.version,
    getPath: () => appState.dataDir,
    on: (event: string, listener: () => void) => {
      appListeners.set(event, listener)
    },
    quit: () => appQuit(),
  },
  shell: {
    openExternal: (url: string) => openExternal(url),
  },
  dialog: {
    showMessageBox: (opts: unknown) => showMessageBox(opts),
  },
}))

type Listener = (...args: unknown[]) => unknown

const updaterState = {
  listeners: new Map<string, Listener>(),
  autoDownload: true,
  autoInstallOnAppQuit: false,
  disableDifferentialDownload: false,
  fullChangelog: false,
  channel: null as string | null,
  allowDowngrade: false,
  allowPrerelease: null as boolean | null,
  // MacUpdater's hand-over of a downloaded zip to Squirrel.Mac, which the Mac
  // install replaces (mac-update.ts installMacStaging)
  updateDownloaded: undefined as unknown,
  // AppUpdater's own answer to "where is the download cache" (it reads
  // app-update.yml for the folder name); a start clears stale installers there
  cacheHelper: (): Promise<{ cacheDir: string }> => Promise.resolve({ cacheDir: '' }),
}
const squirrelServe = vi.fn(() => Promise.resolve([]))
const checkForUpdates = vi.fn(() => Promise.resolve(null))
const downloadUpdate = vi.fn<(token?: FakeCancellationToken) => Promise<unknown>>(() =>
  Promise.resolve([]),
)
class FakeCancellationToken {
  cancelled = false
  cancel(): void {
    this.cancelled = true
  }
}
const quitAndInstall = vi.fn()
const install = vi.fn<(isSilent: boolean, isForceRunAfter: boolean) => boolean>(() => true)

vi.mock('electron-updater', () => ({
  CancellationToken: FakeCancellationToken,
  autoUpdater: {
    on: (event: string, listener: Listener) => {
      updaterState.listeners.set(event, listener)
    },
    checkForUpdates: () => checkForUpdates(),
    downloadUpdate: (token?: FakeCancellationToken) => downloadUpdate(token),
    quitAndInstall: (...args: unknown[]) => quitAndInstall(...(args as [boolean, boolean])),
    install: (isSilent: boolean, isForceRunAfter: boolean) => install(isSilent, isForceRunAfter),
    getOrCreateDownloadHelper: () => updaterState.cacheHelper(),
    get updateDownloaded() {
      return updaterState.updateDownloaded
    },
    set updateDownloaded(v: unknown) {
      updaterState.updateDownloaded = v
    },
    dispatchUpdateDownloaded(event: unknown) {
      updaterState.listeners.get('update-downloaded')?.(event)
    },
    logger: null as unknown,
    set autoDownload(v: boolean) {
      updaterState.autoDownload = v
    },
    set autoInstallOnAppQuit(v: boolean) {
      updaterState.autoInstallOnAppQuit = v
    },
    set disableDifferentialDownload(v: boolean) {
      updaterState.disableDifferentialDownload = v
    },
    set fullChangelog(v: boolean) {
      updaterState.fullChangelog = v
    },
    get fullChangelog() {
      return updaterState.fullChangelog
    },
    set channel(v: string | null) {
      updaterState.channel = v
      // mirrors electron-updater's real setter side effect: assigning
      // `channel` unconditionally flips allowDowngrade to true
      updaterState.allowDowngrade = true
    },
    get channel() {
      return updaterState.channel
    },
    set allowDowngrade(v: boolean) {
      updaterState.allowDowngrade = v
    },
    get allowDowngrade() {
      return updaterState.allowDowngrade
    },
    set allowPrerelease(v: boolean) {
      updaterState.allowPrerelease = v
    },
    get allowPrerelease() {
      return updaterState.allowPrerelease ?? false
    },
  },
}))

interface UpdateActions {
  onDownload: () => void
  onInstall: () => void
  onLater: () => void
  onOpenDownload: () => void
}

type ShowOptions = { inactive?: boolean }
// whether the (mocked) update window is on screen: shown until closed
const updateWindow = { open: false }
const showUpdateWindow = vi.fn<
  (parent: unknown, state: UpdateUiState, actions: UpdateActions, options?: ShowOptions) => void
>(() => {
  updateWindow.open = true
})
const pushUpdateState = vi.fn<(patch: Partial<UpdateUiState>) => void>()
const closeUpdateWindow = vi.fn(() => {
  updateWindow.open = false
})

vi.mock('../src/main/update-attempt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/update-attempt')>()),
  installDirWritable: () => installDir.writable,
}))

// the Mac install: where its bundle is, whether it may replace itself, and the
// macOS programs behind staging and the swap
const macInstall = vi.hoisted(() => ({
  bundle: '/Applications/IeumOffice.app' as string | null,
  block: null as string | null,
  stage: vi.fn<(options: { zip: string; bundle: string; version: string }) => Promise<string>>(),
  swap: vi.fn<(options: unknown) => boolean>(() => true),
  leftovers: vi.fn<(bundle: string) => void>(),
}))
vi.mock('../src/main/mac-update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/mac-update')>()),
  macAppBundle: () => macInstall.bundle,
  macSelfUpdateBlock: () => macInstall.block,
  stageMacUpdate: (options: { zip: string; bundle: string; version: string }) =>
    macInstall.stage(options),
  startMacSwap: (options: unknown) => macInstall.swap(options),
  removeMacLeftovers: (bundle: string) => macInstall.leftovers(bundle),
}))

vi.mock('../src/main/update-window', () => ({
  showUpdateWindow: (...args: [unknown, UpdateUiState, UpdateActions, ShowOptions?]) =>
    showUpdateWindow(...args),
  pushUpdateState: (patch: Partial<UpdateUiState>) => pushUpdateState(patch),
  closeUpdateWindow: () => closeUpdateWindow(),
  isUpdateWindowOpen: () => updateWindow.open,
  setUpdateParentWindow: () => {},
}))

const FIRST_CHECK_DELAY_MS = 15_000
const RECHECK_INTERVAL_MS = 60 * 60 * 1000

let platformSpy: { restore: () => void } | null = null

function setPlatform(platform: string): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  platformSpy = {
    restore: () => Object.defineProperty(process, 'platform', original),
  }
}

async function loadUpdater() {
  return import('../src/main/updater')
}

async function flushAsync(): Promise<void> {
  // drain promise chains queued by download callbacks
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function lastShownState(): UpdateUiState {
  return showUpdateWindow.mock.calls.at(-1)![1]
}

function lastShownActions(): UpdateActions {
  return showUpdateWindow.mock.calls.at(-1)![2]
}

/** the version the mocked app reports (see the electron mock above) */
const CURRENT_VERSION = '0.1.0'
const RELEASES_PATH = `/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases`

/**
 * What github.com answered for the product repository before its first
 * release (recorded 2026-10-13): HTTP 200 and an Atom feed without a single
 * entry. `GET <releases>/latest` answered 302 to the release list at the same
 * time, and `<releases>/latest/download/latest.yml` answered 404.
 */
const EMPTY_RELEASES_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/pblsketch/ieumoffice/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/pblsketch/ieumoffice/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/pblsketch/ieumoffice/releases.atom"/>
  <title>Release notes from seuoffice</title>
  <updated>2026-10-13T06:34:27Z</updated>
</feed>
`

/** A stand-in for the repository's release list as github.com serves it. */
interface FakeGitHub {
  /** tags of the published releases, newest first (the Atom feed's order) */
  tags: string[]
  /** the tag GitHub marks "Latest" — its newest full release; null while only
   * pre-releases exist, which makes `<releases>/latest` redirect to the list */
  latest: string | null
  /** update feed files attached to each release: tag → file name → version */
  assets: Record<string, Record<string, string>>
  /** release bodies as the feed carries them (HTML; escaped into the XML) */
  notes?: Record<string, string>
  /** the release list itself does not answer as a feed */
  listAnswers?: 'not-found' | 'server-error' | 'not-a-feed'
}

const NO_RELEASE: FakeGitHub = { tags: [], latest: null, assets: {} }

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function releasesAtom(tags: string[], notes: Record<string, string> = {}): string {
  const entries = tags.map(
    (tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <updated>2026-10-13T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com${RELEASES_PATH}/tag/${tag}"/>
    <title>${tag}</title>
    <content type="html">${escapeXml(notes[tag] ?? 'notes')}</content>
  </entry>
`,
  )
  return EMPTY_RELEASES_ATOM.replace('</feed>', `${entries.join('')}</feed>`)
}

function feedFile(version: string): string {
  const installer = `IeumOffice-Setup-${version}.exe`
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${installer}`,
    '    sha512: c2hhNTEy',
    '    size: 1',
    `path: ${installer}`,
    'sha512: c2hhNTEy',
    "releaseDate: '2026-10-13T00:00:00.000Z'",
    '',
  ].join('\n')
}

const isNewer = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { numeric: true }) > 0

/**
 * Routes the mocked `checkForUpdates` through electron-updater's real GitHub
 * provider, answering its requests from `github`. The provider reads the
 * channel and pre-release switch the code under test set on the updater, and —
 * like AppUpdater.checkForUpdates — a failure is both emitted as 'error' and
 * rejected, a newer version is announced through 'update-available'.
 * Returns the request paths in the order they were made.
 */
function checkAgainstGitHub(github: FakeGitHub): string[] {
  const requested: string[] = []
  const answer = (path: string): string => {
    requested.push(path)
    if (path === `${RELEASES_PATH}.atom`) {
      if (github.listAnswers === 'not-found') throw new HttpError(404)
      if (github.listAnswers === 'server-error') throw new HttpError(500)
      if (github.listAnswers === 'not-a-feed') return '<!DOCTYPE html><html><body>Sign in</body>'
      return releasesAtom(github.tags, github.notes)
    }
    if (path === `${RELEASES_PATH}/latest`) {
      // electron-updater asks for JSON; without a full release GitHub
      // redirects to the HTML release list instead, which the executor follows
      return github.latest === null
        ? '<!DOCTYPE html><html><body>Releases</body></html>'
        : JSON.stringify({ tag_name: github.latest })
    }
    const download = /\/download\/([^/]+)\/([^/]+)$/.exec(path)
    const version = download ? github.assets[download[1]]?.[download[2]] : undefined
    if (version === undefined) throw new HttpError(404)
    return feedFile(version)
  }
  checkForUpdates.mockImplementation((async () => {
    const provider = new GitHubProvider(
      { provider: 'github', owner: GITHUB_REPO_OWNER, repo: GITHUB_REPO_NAME },
      {
        channel: updaterState.channel,
        allowPrerelease: updaterState.allowPrerelease ?? false,
        // the real AppUpdater hands a semver instance here; full-changelog
        // notes read `.raw`
        currentVersion: { raw: CURRENT_VERSION },
        fullChangelog: updaterState.fullChangelog,
      } as never,
      {
        isUseMultipleRangeRequest: false,
        platform: 'win32',
        executor: { request: async (options: { path: string }) => answer(options.path) },
      } as never,
    )
    try {
      const updateInfo = await provider.getLatestVersion()
      const isUpdateAvailable = isNewer(updateInfo.version, CURRENT_VERSION)
      if (isUpdateAvailable) updaterState.listeners.get('update-available')?.(updateInfo)
      return { isUpdateAvailable, updateInfo }
    } catch (err) {
      updaterState.listeners.get('error')?.(err)
      throw err
    }
  }) as never)
  return requested
}

/** a check that cannot reach the network at all */
function checkOffline(): void {
  checkForUpdates.mockImplementation(() => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED')
    updaterState.listeners.get('error')?.(err)
    return Promise.reject(err)
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  appState.isPackaged = true
  appState.dataDir = mkdtempSync(join(tmpdir(), 'ieum-updater-'))
  appState.version = CURRENT_VERSION
  appListeners.clear()
  appQuit.mockClear()
  install.mockClear()
  installDir.writable = true
  delete process.env.SEUOFFICE_FAKE_UPDATE
  updaterState.listeners.clear()
  updaterState.autoDownload = true
  updaterState.autoInstallOnAppQuit = false
  updaterState.disableDifferentialDownload = false
  updaterState.fullChangelog = false
  updaterState.channel = null
  updaterState.allowDowngrade = false
  updaterState.allowPrerelease = null
  updaterState.updateDownloaded = squirrelServe
  updaterState.cacheHelper = () =>
    Promise.resolve({ cacheDir: join(appState.dataDir, 'no-updater-cache') })
  squirrelServe.mockClear()
  macInstall.bundle = '/Applications/IeumOffice.app'
  macInstall.block = null
  macInstall.stage.mockReset()
  macInstall.stage.mockImplementation((options) =>
    Promise.resolve(`/Applications/.IeumOffice.app.update/IeumOffice-${options.version}.app`),
  )
  macInstall.swap.mockReset()
  macInstall.swap.mockImplementation(() => true)
  macInstall.leftovers.mockClear()
  checkForUpdates.mockReset()
  checkForUpdates.mockImplementation(() => Promise.resolve(null))
  downloadUpdate.mockReset()
  downloadUpdate.mockImplementation(() => Promise.resolve([]))
  quitAndInstall.mockClear()
  showUpdateWindow.mockClear()
  pushUpdateState.mockClear()
  closeUpdateWindow.mockClear()
  updateWindow.open = false
  openExternal.mockClear()
  showMessageBox.mockReset()
  showMessageBox.mockImplementation(() => Promise.resolve({ response: 0 }))
  // the platform that updates itself; a Mac install is pointed at the release page
  setPlatform('win32')
})

afterEach(() => {
  vi.useRealTimers()
  platformSpy?.restore()
  platformSpy = null
  delete process.env.SEUOFFICE_FAKE_UPDATE
  rmSync(appState.dataDir, { recursive: true, force: true })
})

/** the app reaches will-quit: every window closed, no prompt cancelled */
function quitCompletes(): void {
  appListeners.get('will-quit')?.()
}

describe('initAutoUpdater', () => {
  it('does nothing in unpacked (dev) runs without the fake-update env', async () => {
    appState.isPackaged = false
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    expect(updaterState.listeners.size).toBe(0)
    expect(checkForUpdates).not.toHaveBeenCalled()
    expect(showUpdateWindow).not.toHaveBeenCalled()
  })

  it('does nothing on unsupported platforms', async () => {
    platformSpy?.restore()
    setPlatform('linux')
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    expect(updaterState.listeners.size).toBe(0)
    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  it('configures manual differential download and checks after the initial delay', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(updaterState.autoDownload).toBe(false)
    // the installer is started at will-quit by the updater itself
    expect(updaterState.autoInstallOnAppQuit).toBe(false)
    expect(updaterState.disableDifferentialDownload).toBe(false)
    // full changelog: the window shows the bodies of every skipped release
    expect(updaterState.fullChangelog).toBe(true)
    expect(checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('re-checks on the periodic interval', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(RECHECK_INTERVAL_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('skips background checks while automatic checking is off, and resumes when it is back on', async () => {
    let auto = false
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(
      () => null,
      () => auto,
    )
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS + RECHECK_INTERVAL_MS)
    expect(checkForUpdates).not.toHaveBeenCalled()
    // an explicit Help › Check for Updates… still asks the feed
    void checkForUpdatesNow()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    auto = true
    vi.advanceTimersByTime(RECHECK_INTERVAL_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('is idempotent across repeated init calls', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    initAutoUpdater(() => null)
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('opens the update window with the available state when an update is found', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    const state = lastShownState()
    expect(state.phase).toBe('available')
    expect(state.version).toBe('0.2.0')
    expect(state.currentVersion).toBe('0.1.0')
    expect(state.percent).toBe(0)
    // strings are localized main-side and pushed into the window state
    expect(state.strings.title.length).toBeGreaterThan(0)
    expect(state.strings.install.length).toBeGreaterThan(0)
  })

  it('starts the download and pushes progress when the user clicks download', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'downloading', percent: 0 })
    expect(downloadUpdate).toHaveBeenCalledTimes(1)

    updaterState.listeners.get('download-progress')!({ percent: 42 })
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'downloading', percent: 42 })

    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    expect(pushUpdateState).toHaveBeenCalledWith({
      phase: 'downloaded',
      percent: 100,
      visibleInstall: false,
    })
  })

  it('surfaces a failed download as the error phase', async () => {
    downloadUpdate.mockImplementation(() => Promise.reject(new Error('offline')))
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    await flushAsync()
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'error' })
  })

  it('closes the window, quits, and starts the installer only once the quit is certain', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    lastShownActions().onInstall()
    expect(closeUpdateWindow).toHaveBeenCalledTimes(1)
    // the quit is deferred so the window can finish closing first
    expect(appQuit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(appQuit).toHaveBeenCalledTimes(1)
    // save prompts may still be open: the installer must not close the app under them
    expect(install).not.toHaveBeenCalled()
    quitCompletes()
    // Windows: the installer's own window (progress only), which reopens the app
    expect(install).toHaveBeenCalledWith(false, true)
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('says before the restart that the installer window shows and the app comes back', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(lastShownState().strings.restartDesc.length).toBeGreaterThan(0)
  })

  it('keeps the installer silent where no installer window exists (Linux AppImage)', async () => {
    setPlatform('linux')
    process.env.APPIMAGE = '/tmp/IeumOffice.AppImage'
    try {
      const { initAutoUpdater } = await loadUpdater()
      initAutoUpdater(() => null)
      updaterState.listeners.get('update-available')!({ version: '0.2.0' })
      expect(lastShownState().strings.restartDesc).toBe('')
      lastShownActions().onDownload()
      updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
      lastShownActions().onInstall()
      vi.advanceTimersByTime(0)
      quitCompletes()
      expect(install).toHaveBeenCalledWith(true, true)
    } finally {
      delete process.env.APPIMAGE
    }
  })

  it('records the installer start for the next launch to check', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    lastShownActions().onInstall()
    vi.advanceTimersByTime(0)
    quitCompletes()
    const recorded = JSON.parse(
      readFileSync(join(appState.dataDir, 'update-install-attempt.json'), 'utf8'),
    )
    expect(recorded).toEqual({
      version: '0.2.0',
      fromVersion: '0.1.0',
      visible: true,
      tries: 1,
      startedAt: expect.any(String),
    })
  })

  /** the `phase` lines of the update record, without their timestamps */
  function recordedSteps(): string[] {
    return readFileSync(join(appState.dataDir, 'update-log.txt'), 'utf8')
      .split('\n')
      .filter((line) => / info phase /.test(line))
      .map((line) => line.replace(/^\S+ info /, ''))
  }

  it('marks each step of an update in the record, up to the installer start', async () => {
    const installer = join(appState.dataDir, 'SeuOffice-Setup-0.2.0.exe')
    writeFileSync(installer, 'bytes')
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('download-progress')!({ percent: 50, transferred: 4, total: 5 })
    updaterState.listeners.get('update-downloaded')!({
      version: '0.2.0',
      downloadedFile: installer,
    })
    lastShownActions().onInstall()
    vi.advanceTimersByTime(0)
    quitCompletes()
    expect(recordedSteps()).toEqual([
      'phase download-start version=0.2.0',
      expect.stringMatching(/^phase download-end ms=\d+ version=0\.2\.0 bytes=5 transferred=4$/),
      'phase quit-requested version=0.2.0',
      'phase will-quit version=0.2.0',
      'phase installer-start version=0.2.0',
    ])
  })

  it('tells at the first start on the new version how long the update took since the installer started', async () => {
    writeFileSync(
      join(appState.dataDir, 'update-install-attempt.json'),
      JSON.stringify({
        version: '0.2.0',
        fromVersion: '0.1.0',
        visible: true,
        tries: 1,
        startedAt: new Date(Date.now() - 95_000).toISOString(),
      }),
    )
    appState.version = '0.2.0'
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(recordedSteps()).toEqual([
      expect.stringMatching(
        /^phase app-started version=0\.2\.0 from=0\.1\.0 since-install-start-s=95\.0 uptime-s=\d+\.\d$/,
      ),
    ])
  })

  /** an update offered and its download started, which runs until the test ends */
  async function downloadRunning(): Promise<void> {
    downloadUpdate.mockImplementation(() => new Promise(() => {}))
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
  }

  it('asks the feed nothing on schedule while a download runs', async () => {
    await downloadRunning()
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS + RECHECK_INTERVAL_MS)
    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  it('asks the feed nothing on schedule while a finished download waits for the restart', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS + RECHECK_INTERVAL_MS)
    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  it('keeps a running download when a check made meanwhile fails', async () => {
    await downloadRunning()
    // electron-updater reports a failed check through the same 'error' event
    updaterState.listeners.get('error')!(new Error('net::ERR_NETWORK_CHANGED'))
    updaterState.listeners.get('download-progress')!({ percent: 40, transferred: 4, total: 10 })
    expect(pushUpdateState).toHaveBeenLastCalledWith({ phase: 'downloading', percent: 40 })
  })

  it('writes what it did to the update record in the data folder', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(updaterState.logger).not.toBeNull()
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    const record = readFileSync(join(appState.dataDir, 'update-log.txt'), 'utf8')
    expect(record).toContain('running 0.1.0')
    expect(record).toContain('update available: 0.2.0')
  })

  it('a cancelled save prompt calls the restart off', async () => {
    const { initAutoUpdater } = await loadUpdater()
    const { cancelUpdateRestart } = await import('../src/main/update-restart')
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    lastShownActions().onInstall()
    vi.advanceTimersByTime(0)
    // a dirty tab's prompt was answered Cancel: the app stays
    cancelUpdateRestart()
    expect(install).not.toHaveBeenCalled()
    // a later ordinary quit installs nothing
    quitCompletes()
    expect(install).not.toHaveBeenCalled()
  })

  it('never installs on an ordinary quit, where nobody would see it run', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    lastShownActions().onLater()
    quitCompletes()
    expect(install).not.toHaveBeenCalled()
    expect(existsSync(join(appState.dataDir, 'update-install-attempt.json'))).toBe(false)
  })

  it('brings Restart & Install back, unfocused, when a minimized download finishes', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    lastShownActions().onLater()
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(2)
    expect(lastShownState().phase).toBe('downloaded')
    expect(showUpdateWindow.mock.calls.at(-1)![3]).toEqual({ inactive: true })
  })

  it('leaves an open window to show the finished download itself', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
  })

  it('notes in the update record when the installer reopened the app', async () => {
    const argv = process.argv
    process.argv = [...argv, '--updated']
    try {
      const { initAutoUpdater } = await loadUpdater()
      initAutoUpdater(() => null)
    } finally {
      process.argv = argv
    }
    const record = readFileSync(join(appState.dataDir, 'update-log.txt'), 'utf8')
    expect(record).toContain('running 0.1.0 on the stable channel, reopened by the installer')
  })

  describe('the installer the last update left in the download cache', () => {
    /** electron-updater's cache as an update from 0.0.9 to the running 0.1.0 leaves it */
    function staleCache(): { cacheDir: string; installer: string } {
      const cacheDir = join(appState.dataDir, 'updater-cache')
      const installer = join(cacheDir, 'pending', 'SeuOffice-Setup-0.1.0-stable.exe')
      mkdirSync(join(cacheDir, 'pending'), { recursive: true })
      writeFileSync(installer, 'installer bytes')
      writeFileSync(
        join(cacheDir, 'pending', 'update-info.json'),
        JSON.stringify({ fileName: 'SeuOffice-Setup-0.1.0-stable.exe', sha512: 'c2hhNTEy' }),
      )
      return { cacheDir, installer }
    }

    it('is removed at the next start', async () => {
      const { cacheDir, installer } = staleCache()
      updaterState.cacheHelper = () => Promise.resolve({ cacheDir })
      const { initAutoUpdater } = await loadUpdater()
      initAutoUpdater(() => null)
      await flushAsync()
      expect(existsSync(installer)).toBe(false)
    })

    // The installer that reopened the app runs on for a few seconds and holds
    // its own file (Windows answers EPERM); a folder without write permission
    // makes the removal fail the same way here.
    it.skipIf(process.platform === 'win32')(
      'is removed a little later when the installer still held it at the start',
      async () => {
        const { cacheDir, installer } = staleCache()
        updaterState.cacheHelper = () => Promise.resolve({ cacheDir })
        chmodSync(join(cacheDir, 'pending'), 0o555)
        try {
          const { initAutoUpdater } = await loadUpdater()
          initAutoUpdater(() => null)
          await flushAsync()
          expect(existsSync(installer)).toBe(true)
        } finally {
          chmodSync(join(cacheDir, 'pending'), 0o755)
        }
        await vi.advanceTimersByTimeAsync(60_000)
        expect(existsSync(installer)).toBe(false)
      },
    )

    it('stays once a download is running', async () => {
      const { cacheDir, installer } = staleCache()
      let answer: (helper: { cacheDir: string }) => void = () => {}
      // ES2022 lib: no Promise.withResolvers in this workspace's types
      updaterState.cacheHelper = () => new Promise((resolve) => (answer = resolve))
      const { initAutoUpdater } = await loadUpdater()
      initAutoUpdater(() => null)
      updaterState.listeners.get('update-available')!({ version: '0.2.0' })
      lastShownActions().onDownload()
      answer({ cacheDir })
      await flushAsync()
      expect(existsSync(installer)).toBe(true)
    })

    it('a cache that cannot be found is a line in the update record, not a failed start', async () => {
      updaterState.cacheHelper = () => Promise.reject(new Error('no app-update.yml'))
      const { initAutoUpdater } = await loadUpdater()
      expect(() => initAutoUpdater(() => null)).not.toThrow()
      await flushAsync()
      const record = readFileSync(join(appState.dataDir, 'update-log.txt'), 'utf8')
      expect(record).toContain('no app-update.yml')
      // the updater carries on as usual
      vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
      expect(checkForUpdates).toHaveBeenCalledTimes(1)
    })
  })

  it('starts no installer on quit while nothing is downloaded', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    lastShownActions().onInstall()
    vi.advanceTimersByTime(0)
    expect(appQuit).not.toHaveBeenCalled()
    quitCompletes()
    expect(install).not.toHaveBeenCalled()
  })

  it('does not re-prompt for a version the user dismissed this session', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    const available = updaterState.listeners.get('update-available')!
    available({ version: '0.2.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    lastShownActions().onLater()
    expect(closeUpdateWindow).toHaveBeenCalledTimes(1)

    available({ version: '0.2.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)

    // a newer version prompts again
    available({ version: '0.3.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(2)
  })

  it('swallows background check failures', async () => {
    checkForUpdates.mockImplementation(() => Promise.reject(new Error('offline')))
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    await flushAsync()
    expect(showUpdateWindow).not.toHaveBeenCalled()
  })

  it('reads only the Latest release through stable.yml on a stable build', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null, undefined, 'stable')
    expect(updaterState.channel).toBe('stable')
    // must never allow a downgrade, despite electron-updater's channel setter
    // side effect
    expect(updaterState.allowDowngrade).toBe(false)
    // set explicitly: electron-updater turns it on by itself when the
    // installed version is a pre-release
    expect(updaterState.allowPrerelease).toBe(false)
  })

  it('takes the newest release, pre-releases included, on a latest build', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null, undefined, 'latest')
    // left unset: with a channel of its own electron-updater skips every
    // release whose version has no pre-release tag
    expect(updaterState.channel).toBeNull()
    expect(updaterState.allowDowngrade).toBe(false)
    expect(updaterState.allowPrerelease).toBe(true)
  })

  it('stays on stable when the packaged channel cannot be read', async () => {
    // a unit run has no resources/app-update.yml
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(updaterState.channel).toBe('stable')
    expect(updaterState.allowPrerelease).toBe(false)
  })
})

describe('an installer that did not update the app', () => {
  function previousAttempt(visible: boolean, version = '0.2.0', tries?: number): void {
    writeFileSync(
      join(appState.dataDir, 'update-install-attempt.json'),
      JSON.stringify({ version, fromVersion: CURRENT_VERSION, visible, tries }),
    )
  }

  async function downloaded(version = '0.2.0'): Promise<void> {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version })
  }

  it('says so on the next launch and retries in the installer window', async () => {
    previousAttempt(false)
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(lastShownState().phase).toBe('install-failed')
    expect(lastShownState().strings.installFailedDesc.length).toBeGreaterThan(0)

    lastShownActions().onDownload()
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    expect(pushUpdateState).toHaveBeenLastCalledWith({
      phase: 'downloaded',
      percent: 100,
      visibleInstall: false,
    })
    lastShownActions().onInstall()
    vi.advanceTimersByTime(0)
    quitCompletes()
    // not silent: the installer shows its own window, prompts included
    expect(install).toHaveBeenCalledWith(false, true)
    const recorded = JSON.parse(
      readFileSync(join(appState.dataDir, 'update-install-attempt.json'), 'utf8'),
    )
    // the second start for this version: one more failure goes to the download page
    expect(recorded).toMatchObject({ visible: true, tries: 2 })
  })

  it('gives a failed installer window one more try', async () => {
    previousAttempt(true, '0.2.0', 1)
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(lastShownState().phase).toBe('install-failed')
  })

  it('offers a newer release the same way', async () => {
    previousAttempt(false, '0.2.0')
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.3.0' })
    expect(lastShownState().phase).toBe('install-failed')
  })

  it('does not retry silently on an ordinary quit', async () => {
    previousAttempt(false)
    await downloaded()
    lastShownActions().onLater()
    quitCompletes()
    expect(install).not.toHaveBeenCalled()
    // the record stays, so the next launch still knows
    expect(existsSync(join(appState.dataDir, 'update-install-attempt.json'))).toBe(true)
  })

  it('points at the download page once the installer window failed too', async () => {
    previousAttempt(true, '0.2.0', 2)
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(lastShownState().phase).toBe('manual')
    lastShownActions().onOpenDownload()
    expect(openExternal).toHaveBeenCalledWith(githubReleaseTagUrl('0.2.0'))
  })

  it('forgets an attempt that did update the app', async () => {
    previousAttempt(false, '0.2.0')
    appState.version = '0.2.0'
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(existsSync(join(appState.dataDir, 'update-install-attempt.json'))).toBe(false)
    updaterState.listeners.get('update-available')!({ version: '0.3.0' })
    expect(lastShownState().phase).toBe('available')
  })

  it('forgets an attempt from a version the app no longer runs', async () => {
    writeFileSync(
      join(appState.dataDir, 'update-install-attempt.json'),
      JSON.stringify({ version: '0.0.9', fromVersion: '0.0.8', visible: false }),
    )
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(existsSync(join(appState.dataDir, 'update-install-attempt.json'))).toBe(false)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(lastShownState().phase).toBe('available')
  })

  it('ignores a record it cannot read', async () => {
    writeFileSync(join(appState.dataDir, 'update-install-attempt.json'), '{not json')
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(lastShownState().phase).toBe('available')
  })
})

describe('an install folder only an administrator can write', () => {
  beforeEach(() => {
    installDir.writable = false
  })

  it('restarts into the installer window, where the administrator prompt belongs', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(lastShownState().phase).toBe('available')
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    expect(pushUpdateState).toHaveBeenLastCalledWith({
      phase: 'downloaded',
      percent: 100,
      visibleInstall: true,
    })
    lastShownActions().onInstall()
    vi.advanceTimersByTime(0)
    quitCompletes()
    expect(install).toHaveBeenCalledWith(false, true)
  })

  it('reopens a downloaded update with the installer-window wording', async () => {
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    const available = updaterState.listeners.get('update-available')!
    available({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    lastShownActions().onLater()
    checkForUpdates.mockImplementation(() => {
      available({ version: '0.2.0' })
      return Promise.resolve({ isUpdateAvailable: true } as never)
    })
    await checkForUpdatesNow()
    expect(lastShownState().phase).toBe('downloaded')
    expect(lastShownState().visibleInstall).toBe(true)
  })
})

describe('manual download fallback', () => {
  async function failTwiceIntoManual(info: {
    version: string
    files?: { url: string }[]
  }): Promise<UpdateActions> {
    downloadUpdate.mockImplementation(() => Promise.reject(new Error('team id changed')))
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!(info)
    const actions = lastShownActions()
    actions.onDownload()
    await flushAsync()
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'error' })
    actions.onDownload()
    await flushAsync()
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'manual' })
    return actions
  }

  // the offered version may be a release not yet promoted (latest channel),
  // which GitHub's "Latest" page would not show
  it("opens the offered version's release page of the product's repository", async () => {
    const actions = await failTwiceIntoManual({ version: '0.2.0' })
    actions.onOpenDownload()
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(githubReleaseTagUrl('0.2.0'))
    expect(githubReleaseTagUrl('0.2.0')).toBe(
      'https://github.com/seuput-inc/seuoffice/releases/tag/v0.2.0',
    )
  })

  it('never follows a download URL supplied by the update metadata', async () => {
    const actions = await failTwiceIntoManual({
      version: '0.2.0',
      files: [
        { url: 'https://attacker.example/seuoffice-Setup-0.2.0.exe' },
        { url: 'seuoffice-Setup-0.2.0.exe' },
      ],
    })
    actions.onOpenDownload()
    expect(openExternal).toHaveBeenCalledWith(githubReleaseTagUrl('0.2.0'))
  })
})

describe('macOS: the app installs its own update (decision 0097)', () => {
  const zip = '/Users/me/Library/Caches/seuoffice-updater/pending/IeumOffice-0.2.0-arm64-mac.zip'

  beforeEach(() => {
    platformSpy?.restore()
    setPlatform('darwin')
    // electron-updater downloads, checks the sha512, then hands the zip to its
    // own updateDownloaded: which the Mac install has replaced
    downloadUpdate.mockImplementation(() =>
      (updaterState.updateDownloaded as (fileInfo: unknown, event: unknown) => Promise<unknown>)(
        {},
        { version: '0.2.0', downloadedFile: zip },
      ),
    )
  })

  async function downloadedOnMac(): Promise<UpdateActions> {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    const actions = lastShownActions()
    actions.onDownload()
    await flushAsync()
    return actions
  }

  function attemptRecord(): unknown {
    return JSON.parse(readFileSync(join(appState.dataDir, 'update-install-attempt.json'), 'utf8'))
  }

  it('still never lets electron-updater install on quit', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(updaterState.autoDownload).toBe(false)
    expect(updaterState.autoInstallOnAppQuit).toBe(false)
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    quitCompletes()
    expect(install).not.toHaveBeenCalled()
    expect(macInstall.swap).not.toHaveBeenCalled()
  })

  it('offers a found update like Windows does, with the Mac restart wording', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    const state = lastShownState()
    expect(state.phase).toBe('available')
    // the UI language of these tests is en: "replaced with the new version",
    // not the Windows "an installer window shows the progress"
    expect(state.strings.restartDesc).toContain('replaced with the new version')
    expect(state.strings.restartDesc).not.toContain('installer window')
  })

  it('clears what an interrupted update left beside the app', async () => {
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    expect(macInstall.leftovers).toHaveBeenCalledWith('/Applications/IeumOffice.app')
  })

  it('unpacks the download beside the app, never through Squirrel.Mac', async () => {
    await downloadedOnMac()
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(macInstall.stage).toHaveBeenCalledWith({
      zip,
      bundle: '/Applications/IeumOffice.app',
      version: '0.2.0',
      step: expect.any(Function),
    })
    expect(squirrelServe).not.toHaveBeenCalled()
    expect(pushUpdateState).toHaveBeenLastCalledWith({
      phase: 'downloaded',
      percent: 100,
      visibleInstall: false,
    })
  })

  it('swaps the new version in once the app has quit', async () => {
    const actions = await downloadedOnMac()
    actions.onInstall()
    expect(macInstall.swap).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(appQuit).toHaveBeenCalledTimes(1)
    quitCompletes()
    expect(macInstall.swap).toHaveBeenCalledWith({
      pid: process.pid,
      bundle: '/Applications/IeumOffice.app',
      staged: '/Applications/.IeumOffice.app.update/IeumOffice-0.2.0.app',
      logFile: join(appState.dataDir, 'update-log.txt'),
    })
    expect(install).not.toHaveBeenCalled()
    // the next launch checks the version against this record
    expect(attemptRecord()).toEqual({
      version: '0.2.0',
      fromVersion: CURRENT_VERSION,
      visible: false,
      tries: 1,
      startedAt: expect.any(String),
    })
  })

  it('does not swap on an ordinary quit', async () => {
    const actions = await downloadedOnMac()
    actions.onLater()
    quitCompletes()
    expect(macInstall.swap).not.toHaveBeenCalled()
    expect(existsSync(join(appState.dataDir, 'update-install-attempt.json'))).toBe(false)
  })

  it('counts an update that does not check out as a failed download', async () => {
    macInstall.stage.mockImplementation(() =>
      Promise.reject(new Error('a sealed resource is missing')),
    )
    const actions = await downloadedOnMac()
    expect(pushUpdateState).toHaveBeenLastCalledWith({ phase: 'error' })
    actions.onDownload()
    await flushAsync()
    expect(pushUpdateState).toHaveBeenLastCalledWith({ phase: 'manual' })
    actions.onInstall()
    vi.advanceTimersByTime(0)
    quitCompletes()
    expect(macInstall.swap).not.toHaveBeenCalled()
  })

  it('sends a swap that did not take to the download page', async () => {
    writeFileSync(
      join(appState.dataDir, 'update-install-attempt.json'),
      JSON.stringify({ version: '0.2.0', fromVersion: CURRENT_VERSION, visible: false, tries: 1 }),
    )
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    const state = lastShownState()
    expect(state.phase).toBe('manual')
    expect(state.strings.manualDesc).toContain('Mac')
  })

  const cannotReplaceItself: [string, () => void][] = [
    ['from a folder it cannot write', () => (macInstall.block = 'read-only')],
    ['from the disk image or a translocated copy', () => (macInstall.block = 'translocated')],
    ['outside an app bundle', () => (macInstall.bundle = null)],
    // electron-updater without the method the hook replaces
    ['with an electron-updater it cannot hook', () => (updaterState.updateDownloaded = undefined)],
  ]

  it.each(cannotReplaceItself)('keeps the download page for an app run %s', async (_name, set) => {
    set()
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.3.0-beta.1' })
    const state = lastShownState()
    expect(state.phase).toBe('manual')
    expect(state.strings.manualDesc).toContain('Mac')
    const actions = lastShownActions()
    actions.onOpenDownload()
    // Settings → About re-opens the window through onDownload
    actions.onDownload()
    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(pushUpdateState).not.toHaveBeenCalledWith({ phase: 'downloading', percent: 0 })
    expect(openExternal).toHaveBeenCalledTimes(2)
    expect(openExternal).toHaveBeenNthCalledWith(1, githubReleaseTagUrl('0.3.0-beta.1'))
    expect(openExternal).toHaveBeenNthCalledWith(2, githubReleaseTagUrl('0.3.0-beta.1'))
    quitCompletes()
    expect(macInstall.swap).not.toHaveBeenCalled()
  })

  it('keeps the manual phase when a periodic recheck finds the same version', async () => {
    macInstall.block = 'read-only'
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(showUpdateWindow.mock.calls.every((call) => call[1].phase === 'manual')).toBe(true)
  })
})

describe('GitHub Releases feed', () => {
  // every release carries both builds' feeds: latest.yml (general build) and
  // stable.yml (the stable build), and stays a pre-release until promoted
  const feeds = (version: string): Record<string, string> => ({
    'latest.yml': version,
    'stable.yml': version,
  })
  const PROMOTED: FakeGitHub = {
    tags: ['v0.2.0'],
    latest: 'v0.2.0',
    assets: { 'v0.2.0': feeds('0.2.0') },
  }
  const UNPROMOTED_AHEAD: FakeGitHub = {
    tags: ['v0.3.0', 'v0.2.0'],
    latest: 'v0.2.0',
    assets: { 'v0.3.0': feeds('0.3.0'), 'v0.2.0': feeds('0.2.0') },
  }

  async function firstCheck(
    github: FakeGitHub,
    channel: 'stable' | 'latest' = 'stable',
  ): Promise<string[]> {
    const requested = checkAgainstGitHub(github)
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null, undefined, channel)
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
    await flushAsync()
    return requested
  }

  beforeEach(() => {
    platformSpy?.restore()
    setPlatform('win32')
  })

  it("offers a stable build the repository's Latest release from its stable.yml", async () => {
    const requested = await firstCheck(PROMOTED)
    expect(requested).toEqual([
      `${RELEASES_PATH}.atom`,
      `${RELEASES_PATH}/latest`,
      `${RELEASES_PATH}/download/v0.2.0/stable.yml`,
    ])
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    expect(lastShownState().phase).toBe('available')
    expect(lastShownState().version).toBe('0.2.0')
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('keeps a release the owner has not promoted away from a stable build', async () => {
    await firstCheck(UNPROMOTED_AHEAD)
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    expect(lastShownState().version).toBe('0.2.0')
  })

  it('offers a latest build the newest release before it is promoted', async () => {
    const requested = await firstCheck(UNPROMOTED_AHEAD, 'latest')
    // no "Latest" lookup: the newest entry of the release list is taken
    expect(requested).toEqual([
      `${RELEASES_PATH}.atom`,
      `${RELEASES_PATH}/download/v0.3.0/latest.yml`,
    ])
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    expect(lastShownState().version).toBe('0.3.0')
  })

  it('offers a latest build a promoted release as well', async () => {
    const requested = await firstCheck(
      {
        tags: ['v0.4.0', 'v0.3.0'],
        latest: 'v0.4.0',
        assets: { 'v0.4.0': feeds('0.4.0'), 'v0.3.0': feeds('0.3.0') },
      },
      'latest',
    )
    expect(requested.at(-1)).toBe(`${RELEASES_PATH}/download/v0.4.0/latest.yml`)
    expect(lastShownState().version).toBe('0.4.0')
  })

  it('shows a stable build nothing while the only release awaits promotion', async () => {
    await firstCheck({ tags: ['v0.2.0'], latest: null, assets: { 'v0.2.0': feeds('0.2.0') } })
    expect(showUpdateWindow).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('drives the download phases for a release found on GitHub', async () => {
    await firstCheck(PROMOTED)
    lastShownActions().onDownload()
    expect(pushUpdateState).toHaveBeenLastCalledWith({ phase: 'downloading', percent: 0 })
    updaterState.listeners.get('download-progress')!({ percent: 64 })
    expect(pushUpdateState).toHaveBeenLastCalledWith({ phase: 'downloading', percent: 64 })
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    expect(pushUpdateState).toHaveBeenLastCalledWith({
      phase: 'downloaded',
      percent: 100,
      visibleInstall: false,
    })
    lastShownActions().onInstall()
    vi.advanceTimersByTime(0)
    quitCompletes()
    expect(install).toHaveBeenCalledWith(false, true)
  })

  it('converts the release body into notes on the shown state', async () => {
    await firstCheck({
      tags: ['v0.2.0'],
      latest: 'v0.2.0',
      assets: { 'v0.2.0': feeds('0.2.0') },
      notes: {
        'v0.2.0':
          '<p>새 기능</p><ul><li><strong>하나</strong></li><li>둘</li></ul><script>alert(1)</script>',
      },
    })
    expect(lastShownState().releaseNotes).toEqual({
      sections: [
        {
          version: '0.2.0',
          blocks: [
            { kind: 'paragraph', runs: [{ text: '새 기능' }] },
            {
              kind: 'list',
              ordered: false,
              items: [[{ text: '하나', strong: true }], [{ text: '둘' }]],
            },
          ],
        },
      ],
      truncated: false,
    })
  })

  it('shows no notes when the release has no body', async () => {
    await firstCheck({
      tags: ['v0.2.0'],
      latest: 'v0.2.0',
      assets: { 'v0.2.0': feeds('0.2.0') },
      notes: { 'v0.2.0': 'No content.' },
    })
    expect(lastShownState().releaseNotes).toBeNull()
  })
})

/**
 * spec 4.13: a missing release or a failed check is passed over quietly and
 * never gets in the way of using the app. Each case names what the update
 * feed did and what a user who asked for the check is told: "you're up to
 * date" when the repository has nothing for this install, "couldn't check"
 * when the check could not run.
 */
describe('quiet failure', () => {
  const cases: {
    name: string
    arrange: () => void
    manualAnswer: 'up-to-date' | 'could-not-check'
  }[] = [
    {
      name: 'the repository has no release at all',
      arrange: () => checkAgainstGitHub(NO_RELEASE),
      manualAnswer: 'up-to-date',
    },
    {
      name: 'the only release awaits promotion and the build is stable',
      arrange: () =>
        checkAgainstGitHub({
          tags: ['v0.2.0'],
          latest: null,
          assets: { 'v0.2.0': { 'stable.yml': '0.2.0' } },
        }),
      manualAnswer: 'up-to-date',
    },
    {
      name: 'the Latest release carries no stable.yml',
      arrange: () => checkAgainstGitHub({ tags: ['v0.2.0'], latest: 'v0.2.0', assets: {} }),
      manualAnswer: 'up-to-date',
    },
    {
      name: 'GitHub answers 404 for the release list',
      arrange: () => checkAgainstGitHub({ ...NO_RELEASE, listAnswers: 'not-found' }),
      manualAnswer: 'up-to-date',
    },
    {
      name: 'there is no network',
      arrange: checkOffline,
      manualAnswer: 'could-not-check',
    },
    {
      name: 'GitHub answers with a server error',
      arrange: () => checkAgainstGitHub({ ...NO_RELEASE, listAnswers: 'server-error' }),
      manualAnswer: 'could-not-check',
    },
    {
      // e.g. a captive portal's page. electron-updater reports it exactly like
      // an empty release list (no <entry> in what it parsed), so the two
      // cannot be told apart and it reads as "nothing newer".
      name: 'an HTML page answers instead of the release list',
      arrange: () => checkAgainstGitHub({ ...NO_RELEASE, listAnswers: 'not-a-feed' }),
      manualAnswer: 'up-to-date',
    },
  ]

  beforeEach(() => {
    platformSpy?.restore()
    setPlatform('win32')
  })

  for (const { name, arrange, manualAnswer } of cases) {
    it(`background check shows nothing when ${name}`, async () => {
      arrange()
      const { initAutoUpdater } = await loadUpdater()
      initAutoUpdater(() => null)
      vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS)
      await flushAsync()

      expect(checkForUpdates).toHaveBeenCalledTimes(1)
      expect(showMessageBox).not.toHaveBeenCalled()
      expect(showUpdateWindow).not.toHaveBeenCalled()
      expect(pushUpdateState).not.toHaveBeenCalled()
      expect(openExternal).not.toHaveBeenCalled()

      // the app goes on, and so does checking: a release published later is
      // picked up by the next periodic check
      checkAgainstGitHub({
        tags: ['v0.2.0'],
        latest: 'v0.2.0',
        assets: { 'v0.2.0': { 'stable.yml': '0.2.0' } },
      })
      vi.advanceTimersByTime(RECHECK_INTERVAL_MS)
      await flushAsync()
      expect(showUpdateWindow).toHaveBeenCalledTimes(1)
      expect(lastShownState().version).toBe('0.2.0')
      expect(showMessageBox).not.toHaveBeenCalled()
    })

    it(`a requested check answers "${manualAnswer}" when ${name}`, async () => {
      arrange()
      const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
      initAutoUpdater(() => null)

      await expect(checkForUpdatesNow()).resolves.toBeUndefined()

      expect(showUpdateWindow).not.toHaveBeenCalled()
      expect(showMessageBox).toHaveBeenCalledTimes(1)
      const opts = showMessageBox.mock.calls[0][0] as { type: string; message: string }
      if (manualAnswer === 'up-to-date') {
        expect(opts.type).toBe('info')
        expect(opts.message).toContain(CURRENT_VERSION)
      } else {
        expect(opts.type).toBe('warning')
        expect(opts.message).not.toContain(CURRENT_VERSION)
      }
      // never an error box, and nothing that has to be answered to keep working
      expect(opts.type).not.toBe('error')
      expect(openExternal).not.toHaveBeenCalled()
    })
  }
})

describe('initAutoUpdater (fake update preview)', () => {
  it('runs a simulated download to completion in unpacked runs', async () => {
    appState.isPackaged = false
    process.env.SEUOFFICE_FAKE_UPDATE = '9.9.9'
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)

    // the fake flow never touches the real updater
    expect(updaterState.listeners.size).toBe(0)

    vi.advanceTimersByTime(1500)
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    expect(lastShownState().version).toBe('9.9.9')
    // two canned sections so the skipped-versions layout is visible
    expect(lastShownState().releaseNotes?.sections).toHaveLength(2)

    lastShownActions().onDownload()
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'downloading', percent: 0 })
    vi.advanceTimersByTime(3000)
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'downloaded', percent: 100 })
    expect(checkForUpdates).not.toHaveBeenCalled()
    expect(downloadUpdate).not.toHaveBeenCalled()
  })

  it('closes the window on later and install without touching electron-updater', async () => {
    appState.isPackaged = false
    process.env.SEUOFFICE_FAKE_UPDATE = '9.9.9'
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    vi.advanceTimersByTime(1500)

    lastShownActions().onLater()
    expect(closeUpdateWindow).toHaveBeenCalledTimes(1)
    lastShownActions().onInstall()
    expect(closeUpdateWindow).toHaveBeenCalledTimes(2)
    expect(quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('checkForUpdatesNow (r148 manual check)', () => {
  function lastDialogOpts(): { type: string; message: string; buttons: string[] } {
    return showMessageBox.mock.calls.at(-1)![0] as never
  }

  it('points installs without a self-update mechanism at the download page', async () => {
    appState.isPackaged = false
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    showMessageBox.mockImplementation(() => Promise.resolve({ response: 1 }))

    await checkForUpdatesNow()

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(lastDialogOpts().buttons.length).toBe(2)
    expect(openExternal).toHaveBeenCalledWith(GITHUB_LATEST_RELEASE_URL)
    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  it("shows you're-up-to-date (with the current version) when nothing newer exists", async () => {
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    checkForUpdates.mockImplementation(() => Promise.resolve({ isUpdateAvailable: false } as never))

    await checkForUpdatesNow()

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(lastDialogOpts().type).toBe('info')
    expect(lastDialogOpts().message).toContain('0.1.0')
    expect(showUpdateWindow).not.toHaveBeenCalled()
  })

  it('does not report up-to-date when the updater skips the check', async () => {
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    checkForUpdates.mockImplementation(() => Promise.resolve(null))
    await checkForUpdatesNow()
    expect(lastDialogOpts().type).toBe('warning')
    expect(showUpdateWindow).not.toHaveBeenCalled()
    expect(downloadUpdate).not.toHaveBeenCalled()
  })

  it('ignores duplicate clicks while checking and allows a retry afterwards', async () => {
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    let resolveCheck!: (value: null) => void
    checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve
        }),
    )
    const pending = checkForUpdatesNow()
    await checkForUpdatesNow()
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
    expect(showMessageBox).not.toHaveBeenCalled()
    resolveCheck(null)
    await pending
    await checkForUpdatesNow()
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
    expect(downloadUpdate).not.toHaveBeenCalled()
  })

  it('re-offers a version the user dismissed with "later" this session', async () => {
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    lastShownActions().onLater()
    // background recheck stays quiet for the dismissed version…
    updaterState.listeners.get('update-available')!({ version: '0.2.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    // …but an explicit user check offers it again, with no extra dialog
    checkForUpdates.mockImplementation(() => {
      updaterState.listeners.get('update-available')!({ version: '0.2.0' })
      return Promise.resolve({ isUpdateAvailable: true } as never)
    })

    await checkForUpdatesNow()

    expect(showUpdateWindow).toHaveBeenCalledTimes(2)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('resumes a downloaded update at Restart & Install instead of re-offering the download', async () => {
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    const available = updaterState.listeners.get('update-available')!
    available({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    lastShownActions().onLater()
    checkForUpdates.mockImplementation(() => {
      available({ version: '0.2.0' })
      return Promise.resolve({ isUpdateAvailable: true } as never)
    })

    await checkForUpdatesNow()

    expect(showUpdateWindow).toHaveBeenCalledTimes(2)
    expect(lastShownState().phase).toBe('downloaded')
    expect(lastShownState().percent).toBe(100)
    lastShownActions().onDownload()
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('resumes an in-flight download with its progress and does not start a second one', async () => {
    downloadUpdate.mockImplementation(() => new Promise(() => {}))
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    const available = updaterState.listeners.get('update-available')!
    available({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('download-progress')!({ percent: 37 })
    lastShownActions().onLater()
    checkForUpdates.mockImplementation(() => {
      available({ version: '0.2.0' })
      return Promise.resolve({ isUpdateAvailable: true } as never)
    })

    await checkForUpdatesNow()

    expect(lastShownState().phase).toBe('downloading')
    expect(lastShownState().percent).toBe(37)
    lastShownActions().onDownload()
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('leaves a newer version alone while the previous one is downloading or downloaded', async () => {
    downloadUpdate.mockImplementation(() => new Promise(() => {}))
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    const available = updaterState.listeners.get('update-available')!
    available({ version: '0.2.0' })
    lastShownActions().onDownload()
    available({ version: '0.3.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    updaterState.listeners.get('update-downloaded')!({ version: '0.2.0' })
    available({ version: '0.3.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    lastShownActions().onDownload()
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('brings back the in-progress flow when a manual check finds a newer version mid-download', async () => {
    downloadUpdate.mockImplementation(() => new Promise(() => {}))
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    const available = updaterState.listeners.get('update-available')!
    available({ version: '0.2.0' })
    lastShownActions().onDownload()
    updaterState.listeners.get('download-progress')!({ percent: 58 })
    lastShownActions().onLater()
    // background recheck with a newer version stays quiet…
    available({ version: '0.3.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    // …an explicit check re-opens the download that is already running
    checkForUpdates.mockImplementation(() => {
      available({ version: '0.3.0' })
      return Promise.resolve({ isUpdateAvailable: true } as never)
    })

    await checkForUpdatesNow()

    expect(showUpdateWindow).toHaveBeenCalledTimes(2)
    expect(lastShownState().version).toBe('0.2.0')
    expect(lastShownState().phase).toBe('downloading')
    expect(lastShownState().percent).toBe(58)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('offers a newer version from scratch after the previous download failed', async () => {
    downloadUpdate.mockImplementation(() => Promise.reject(new Error('offline')))
    const { initAutoUpdater } = await loadUpdater()
    initAutoUpdater(() => null)
    const available = updaterState.listeners.get('update-available')!
    available({ version: '0.2.0' })
    lastShownActions().onDownload()
    await flushAsync()
    expect(pushUpdateState).toHaveBeenCalledWith({ phase: 'error' })
    available({ version: '0.3.0' })
    expect(showUpdateWindow).toHaveBeenCalledTimes(2)
    expect(lastShownState().version).toBe('0.3.0')
    expect(lastShownState().phase).toBe('available')
    expect(lastShownState().percent).toBe(0)
  })

  it('shows the failure dialog when the check itself fails', async () => {
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)
    checkForUpdates.mockImplementation(() => Promise.reject(new Error('offline')))

    await checkForUpdatesNow()

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(lastDialogOpts().type).toBe('warning')
    expect(showUpdateWindow).not.toHaveBeenCalled()
  })

  it('re-shows the simulated update window in SEUOFFICE_FAKE_UPDATE runs', async () => {
    appState.isPackaged = false
    process.env.SEUOFFICE_FAKE_UPDATE = '9.9.9'
    const { initAutoUpdater, checkForUpdatesNow } = await loadUpdater()
    initAutoUpdater(() => null)

    await checkForUpdatesNow()

    expect(showUpdateWindow).toHaveBeenCalledTimes(1)
    expect(lastShownState().version).toBe('9.9.9')
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
