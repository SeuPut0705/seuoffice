/**
 * Group `a/drive`: Google Drive in the shell's main process
 * (`apps/shell/src/main/drive/*.ts`), configured as the shell entry
 * configures it: `readStoredAiSettings`, `APP_SETTINGS_PATH` and the
 * `driveService = registerDriveIpc({...})` call are the entry's own
 * statements.
 *
 * What the module reaches outside itself is replaced, the same way on both
 * sides (the Rust half is crates/shell-ipc/a/src/probe/drive.rs, which reads
 * the same `hosts.a.drive` and logs the same lines; its header lists the
 * keys):
 *
 * - `@seuoffice/google-drive`: a resolve hook answers it for the Drive
 *   modules with a stub whose `DriveConnection` is a scripted world (below),
 *   over the real token vault of drive-vault.ts and a fake `safeStorage` that
 *   is not available unless the case says so. The pure helpers (`openPlan`,
 *   `localFileName`, ...) are the package's own.
 * - `electron`'s `safeStorage` (the fake Electron has none): the same hook.
 * - the entry's tabs and parser: `routeDocumentPath` and `parseFileToText`
 *   log a line each.
 * - time and chance: `Date.now()` is the case's clock (it moves `step`
 *   milliseconds at each Drive call), the download folders of attachments
 *   are counted (`randomBytes` of drive-attach.ts), the folder watcher never
 *   reports and timers of a second or more do not keep the process alive.
 *
 * Every handler of a case waits until the module's disk work is done before
 * it answers, so what the Rust side does on workers lines up.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { basename, join, resolve } from 'node:path'
import { freeAiInUse } from '../../../../apps/shell/src/main/drive/drive-consent.ts'
import { normalizeAiSettings } from '../../../../packages/ai-provider/src/index.ts'
import { MAX_OPEN_BYTES, MAX_READ_BYTES } from '../../../../packages/google-drive/src/drive-api.ts'
import * as formats from '../../../../packages/google-drive/src/formats.ts'
import type { Call, Case, Group, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

const MODULE = 'apps/shell/src/main/drive/drive-ipc.ts'
type DriveIpc = typeof import('../../../../apps/shell/src/main/drive/drive-ipc.ts')

const entryCode = entryStatements('apps/shell/src/main/index.ts', [
  'function readStoredAiSettings(',
  'const APP_SETTINGS_PATH =',
  'driveService = registerDriveIpc({',
])

// ---- the world a case scripts (`hosts.a.drive`) ----------------------------

interface Spec {
  id?: string
  name?: string
  mime?: string
  modified?: string
  size?: number
  md5?: string
  parents?: string[]
  canEdit?: boolean
  shortcut?: { id: string; mime: string }
  text?: string
  hex?: string
  fileError?: string
  downloadError?: string
  exportError?: string
}

interface World {
  unavailable?: boolean
  safeStorage?: {
    available?: boolean
    backend?: string
    failEncrypt?: boolean
    failDecrypt?: boolean
  }
  token?: string
  account?: { displayName: string; emailAddress: string }
  connects?: string[]
  picks?: (string[] | string)[]
  authUrls?: string[]
  files?: Record<string, Spec>
  lists?: { files?: Spec[]; next?: string; error?: string }[]
  uploads?: { error?: string }[]
  expireOnApi?: boolean
  parse?: Record<string, { ok?: boolean; kind?: string; text?: string }>
  openFiles?: string[]
  openPath?: boolean
  step?: number
  now?: number
}

const DEFAULT_NOW = 1_700_000_000_000
const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test'

interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: number
  md5Checksum?: string
  parents?: string[]
  canEdit: boolean
  shortcutTarget?: { id: string; mimeType: string }
}

type Fail = { ok: false; kind: string }
type Fn = (...args: unknown[]) => unknown

interface TokenVault {
  load(): Promise<string | null>
  save(token: string): Promise<boolean>
  clear(): Promise<void>
}

interface Options {
  client: unknown
  vault: TokenVault
}

interface SignInOptions {
  openBrowser(url: string): Promise<boolean>
  pages: unknown
}

/** what one case shares with the stubs the hooks answer with */
const box = {
  world: {} as World | null,
  log: [] as unknown[],
  clock: DEFAULT_NOW,
  folders: 0,
  safeStorage: {} as Record<string, unknown>,
  formats,
  consts: { MAX_OPEN_BYTES, MAX_READ_BYTES },
  Connection: null as unknown as new (options: Options) => unknown,
  randomBytes: (n: number): Buffer => {
    const bytes = Buffer.alloc(n)
    bytes.writeUIntBE(++box.folders, n - 6, 6)
    return bytes
  },
}
const BOX = Symbol.for('ipc-diff.drive')
;(globalThis as Record<symbol, unknown>)[BOX] = box

const md5Of = (bytes: Buffer): string =>
  `md5-${bytes.length}-${bytes.reduce((sum, b) => sum + b, 0)}`

function fileOf(spec: Spec, id: string): DriveFile {
  const file: DriveFile = {
    id,
    name: spec.name ?? '',
    mimeType: spec.mime ?? '',
    modifiedTime: spec.modified ?? '',
    canEdit: spec.canEdit ?? true,
  }
  if (spec.size !== undefined) file.size = spec.size
  if (spec.md5 !== undefined) file.md5Checksum = spec.md5
  if (spec.parents) file.parents = spec.parents
  if (spec.shortcut) file.shortcutTarget = { id: spec.shortcut.id, mimeType: spec.shortcut.mime }
  return file
}

const bytesOf = (spec: Spec): Buffer =>
  spec.hex !== undefined ? Buffer.from(spec.hex, 'hex') : Buffer.from(spec.text ?? '', 'utf8')

/** `DriveConnection` of packages/google-drive, over the scripted world and the real vault */
class Connection {
  private refreshToken: string | null = null
  private account: { displayName: string; emailAddress: string } | null = null
  private persisted = false
  private expired = false
  private loaded = false
  private expiredOnce = false
  private readonly listeners = new Set<() => void>()
  private readonly world: World = box.world ?? {}
  private readonly log = box.log
  private readonly connects = [...(this.world.connects ?? [])]
  private readonly picks = [...(this.world.picks ?? [])]
  private readonly authUrls = [...(this.world.authUrls ?? [])]
  private readonly lists = [...(this.world.lists ?? [])]
  private readonly uploads = [...(this.world.uploads ?? [])]
  private uploadCalls = 0
  private newFiles = 0
  private readonly store = new Map<string, { file: DriveFile; bytes: Buffer }>(
    Object.entries(this.world.files ?? {}).map(([id, spec]) => [
      id,
      { file: fileOf(spec, id), bytes: bytesOf(spec) },
    ]),
  )
  readonly api: Record<string, Fn>

  constructor(private readonly options: Options) {
    this.api = {
      list: (listing, options) =>
        this.list(listing, options as Record<string, unknown> | undefined),
      file: (id) => this.file(id as string),
      download: (id, max) =>
        this.bytes(['api.download', id, max], id as string, max as number, 'downloadError'),
      export: (id, mime, max) =>
        this.bytes(['api.export', id, mime, max], id as string, max as number, 'exportError'),
      upload: (target, bytes, mime) =>
        this.upload(target as Record<string, unknown>, bytes as Buffer, mime as string),
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  state(): unknown {
    if (!this.options.client) return { state: 'unavailable' }
    if (!this.refreshToken) {
      return this.expired ? { state: 'disconnected', expired: true } : { state: 'disconnected' }
    }
    return { state: 'connected', account: this.account, persisted: this.persisted }
  }

  connected(): boolean {
    return Boolean(this.options.client && this.refreshToken)
  }

  async load(): Promise<unknown> {
    if (this.loaded || !this.options.client) return this.state()
    this.loaded = true
    const token = await this.options.vault.load().catch(() => null)
    if (token && !this.refreshToken) {
      this.refreshToken = token
      this.persisted = true
      this.emit()
      void this.fetchAccount()
    }
    return this.state()
  }

  private async fetchAccount(): Promise<void> {
    const account = this.world.account
    if (account && this.refreshToken) {
      this.account = account
      this.emit()
    }
  }

  async connect(options: SignInOptions): Promise<unknown> {
    this.log.push(['connection.connect', options.pages])
    const result = await this.signInOnce(options, undefined)
    return result.ok ? { ok: true } : result
  }

  async pick(options: SignInOptions, multiple: boolean): Promise<unknown> {
    this.log.push(['connection.pick', options.pages, multiple])
    return this.signInOnce(options, multiple)
  }

  private async signInOnce(
    options: SignInOptions,
    pick: boolean | undefined,
  ): Promise<{ ok: true; picked: string[] } | { ok: false; reason: string }> {
    if (!this.options.client) return { ok: false, reason: 'unavailable' }
    const url = this.authUrls.shift() ?? DEFAULT_AUTH_URL
    const outcome = pick === undefined ? this.connects.shift() : this.picks.shift()
    if (!(await options.openBrowser(url))) return { ok: false, reason: 'network' }
    if (typeof outcome === 'string' && outcome !== 'ok') return { ok: false, reason: outcome }
    const picked = pick !== undefined && Array.isArray(outcome) ? outcome : []
    const account = this.refreshToken ? this.account : null
    const token = this.world.token ?? 'refresh-1'
    this.refreshToken = token
    this.account = null
    this.expired = false
    this.persisted = await this.options.vault.save(token).catch(() => false)
    if (!this.persisted) await this.options.vault.clear().catch(() => {})
    if (account) this.account = account
    this.emit()
    if (!account) await this.fetchAccount()
    return { ok: true, picked }
  }

  cancelConnect(): void {
    this.log.push(['connection.cancelConnect'])
  }

  async disconnect(): Promise<void> {
    this.log.push(['connection.disconnect'])
    this.forget(false)
    await this.options.vault.clear().catch(() => {})
  }

  private forget(expired: boolean): void {
    this.refreshToken = null
    this.account = null
    this.persisted = false
    this.expired = expired
    this.emit()
  }

  /** What every Drive call starts with: its log line, the clock, and the connection it needs */
  private async call(line: unknown[]): Promise<Fail | null> {
    this.log.push(line)
    box.clock += this.world.step ?? 0
    if (!this.refreshToken) return { ok: false, kind: 'not-connected' }
    if (this.world.expireOnApi === true && !this.expiredOnce) {
      this.expiredOnce = true
      this.forget(true)
      await this.options.vault.clear().catch(() => {})
      return { ok: false, kind: 'not-connected' }
    }
    return null
  }

  private async list(listing: unknown, options: Record<string, unknown> | undefined) {
    const given: Record<string, unknown> = {}
    if (options?.pageToken !== undefined) given.pageToken = options.pageToken
    if (options?.pageSize !== undefined) given.pageSize = options.pageSize
    const failed = await this.call(['api.list', listing, given])
    if (failed) return failed
    const answer = this.lists.shift()
    if (!answer) return { ok: true, files: [] }
    if (answer.error !== undefined) return { ok: false, kind: answer.error }
    const files = (answer.files ?? []).map((spec) => fileOf(spec, spec.id ?? ''))
    return answer.next !== undefined
      ? { ok: true, files, nextPageToken: answer.next }
      : { ok: true, files }
  }

  private async file(id: string) {
    const failed = await this.call(['api.file', id])
    if (failed) return failed
    const spec = this.world.files?.[id]
    if (spec?.fileError !== undefined) return { ok: false, kind: spec.fileError }
    const found = this.store.get(id)
    return found ? { ok: true, file: { ...found.file } } : { ok: false, kind: 'not-found' }
  }

  private async bytes(line: unknown[], id: string, max: number, errorKey: keyof Spec) {
    const failed = await this.call(line)
    if (failed) return failed
    const found = this.store.get(id)
    if (!found) return { ok: false, kind: 'not-found' }
    const error = this.world.files?.[id]?.[errorKey]
    if (typeof error === 'string') return { ok: false, kind: error }
    if (found.bytes.length > max) return { ok: false, kind: 'too-large' }
    return { ok: true, bytes: new Uint8Array(found.bytes) }
  }

  private async upload(target: Record<string, unknown>, bytes: Buffer, mime: string) {
    const shown: Record<string, unknown> = {}
    if (target.existingId !== undefined) shown.existingId = target.existingId
    else {
      shown.name = target.name
      if (target.parentId !== undefined) shown.parentId = target.parentId
    }
    const failed = await this.call(['api.upload', shown, Buffer.from(bytes).toString('hex'), mime])
    if (failed) return failed
    const call = ++this.uploadCalls
    const answer = this.uploads.shift()
    if (answer?.error !== undefined) return { ok: false, kind: answer.error }
    const modified = `2026-02-01T00:00:${String(call).padStart(2, '0')}Z`
    const body = Buffer.from(bytes)
    if (typeof target.existingId === 'string') {
      const found = this.store.get(target.existingId)
      if (!found) return { ok: false, kind: 'not-found' }
      found.bytes = body
      found.file = {
        ...found.file,
        md5Checksum: md5Of(body),
        size: body.length,
        modifiedTime: modified,
      }
      return { ok: true, file: { ...found.file } }
    }
    const id = `made-${++this.newFiles}`
    const file: DriveFile = {
      id,
      name: target.name as string,
      mimeType: mime,
      modifiedTime: modified,
      size: body.length,
      md5Checksum: md5Of(body),
      canEdit: true,
    }
    if (typeof target.parentId === 'string') file.parents = [target.parentId]
    this.store.set(id, { file, bytes: body })
    return { ok: true, file: { ...file } }
  }
}
box.Connection = Connection as unknown as typeof box.Connection

// ---- the hooks ---------------------------------------------------------------

interface Hooks {
  resolve(
    specifier: string,
    context: { parentURL?: string },
    next: (specifier: string, context: unknown) => unknown,
  ): unknown
  load(url: string, context: unknown, next: (url: string, context: unknown) => unknown): unknown
}

/** `module.registerHooks` is Node 22.15 and later; its types may be older than the runtime */
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: Hooks): unknown }

const SOURCES: Record<string, string> = {
  'ipc-diff:drive-google': [
    `const box = globalThis[Symbol.for('ipc-diff.drive')]`,
    'export const FOLDER_MIME = box.formats.FOLDER_MIME',
    'export const MAX_READ_BYTES = box.consts.MAX_READ_BYTES',
    'export const MAX_OPEN_BYTES = box.consts.MAX_OPEN_BYTES',
    ...['openPlan', 'isGoogleNative', 'localFileName', 'officeCopyName', 'uploadMime'].map(
      (name) => `export const ${name} = (...args) => box.formats.${name}(...args)`,
    ),
    'export class DriveConnection { constructor(options) { return new box.Connection(options) } }',
  ].join('\n'),
  // the fake Electron has no safeStorage
  'ipc-diff:drive-electron': [
    `import * as fake from 'electron'`,
    `export * from 'electron'`,
    `const box = globalThis[Symbol.for('ipc-diff.drive')]`,
    'export const safeStorage = new Proxy({}, { get: (_, key) => box.safeStorage[key] })',
  ].join('\n'),
  // no folder watcher: a save is not something a case waits for
  'ipc-diff:drive-fs': [
    `export * from 'node:fs'`,
    'export function watch() { return { on() {}, close() {} } }',
  ].join('\n'),
  // the folders of attachments are counted
  'ipc-diff:drive-crypto': [
    `export * from 'node:crypto'`,
    `const box = globalThis[Symbol.for('ipc-diff.drive')]`,
    'export const randomBytes = (n) => box.randomBytes(n)',
  ].join('\n'),
}

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (parent.includes('/apps/shell/src/main/drive/')) {
      if (specifier === '@seuoffice/google-drive') {
        return { url: 'ipc-diff:drive-google', shortCircuit: true }
      }
      if (specifier === 'electron' && parent.includes('/drive-ipc.ts')) {
        return { url: 'ipc-diff:drive-electron', shortCircuit: true }
      }
      if (specifier === 'node:fs' && parent.includes('/drive-files.ts')) {
        return { url: 'ipc-diff:drive-fs', shortCircuit: true }
      }
      if (specifier === 'node:crypto' && parent.includes('/drive-attach.ts')) {
        return { url: 'ipc-diff:drive-crypto', shortCircuit: true }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const source = SOURCES[url]
    return source === undefined
      ? next(url, context)
      : { format: 'module', source, shortCircuit: true }
  },
})

// `Date.now()` is the case's clock
Date.now = () => box.clock
// a timer of a second or more (the sync's retry and debounce) must not keep the process alive
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
  const timer = realSetTimeout(handler, ms, ...rest)
  if (typeof ms === 'number' && ms >= 1000) timer.unref()
  return timer
}) as typeof setTimeout
const realImmediate = globalThis.setImmediate

/** Until the disk work the module started is done (and nothing else is waiting for it) */
async function quiet(): Promise<void> {
  for (let calm = 0, round = 0; calm < 6 && round < 20_000; round++) {
    await new Promise<void>((done) => realImmediate(done))
    const busy = process
      .getActiveResourcesInfo()
      .some((name) => name.startsWith('FSReq') || name === 'CloseReq')
    calm = busy ? 0 : calm + 1
    if (busy) await new Promise<void>((done) => setTimeout(done, 1))
  }
}

// ---- the cases ------------------------------------------------------------------

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Docs' },
]
const shell = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
const docs = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
const state = (): Call => shell('drive:state')

/** `hosts` of a case: the world, and the folder the Rust fakes read the files from */
const hosts = (drive: World, more: Record<string, unknown> = {}, shared?: unknown) => ({
  a: { dir: '$DIR', drive, ...more },
  ...(shared === undefined ? {} : { shared }),
})

const sealed = (token: string): string =>
  Buffer.from(Buffer.from(token, 'utf8').map((b) => b ^ 0x5a)).toString('base64')
const vaultFile = (token = 'saved-token') => ({
  'userData/google-drive.json': JSON.stringify({ version: 1, token: sealed(token) }),
})
const settings = (value: unknown) => ({ 'userData/app-settings.json': JSON.stringify(value) })
const ack = settings({ driveTrainingAck: true })
const keyring: World['safeStorage'] = { available: true }
const dana = { displayName: 'Dana Kim', emailAddress: 'dana@example.com' }

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const GDOC = 'application/vnd.google-apps.document'
const GSHEET = 'application/vnd.google-apps.spreadsheet'
const FOLDER = 'application/vnd.google-apps.folder'
const SHORTCUT = 'application/vnd.google-apps.shortcut'

/** The cache folder of the copies of opened Drive files, as the module names it */
const CACHE = '$DIR/userData/drive-cache'
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** One copy of a Drive file in the cache: its entry of index.json and the files on disk */
function copy(
  over: Record<string, unknown> = {},
  local = 'v1',
  dirty = false,
): Record<string, string> {
  const entry = {
    sourceId: 'doc1',
    google: false,
    name: 'plan.docx',
    parentId: 'folder-1',
    localPath: `${CACHE}/doc1/plan.docx`,
    syncedSha: sha('v1'),
    targetId: 'doc1',
    targetMd5: md5('v1'),
    targetModified: '2026-01-01T00:00:00Z',
    sourceModified: '2026-01-01T00:00:00Z',
    detached: false,
    openedAt: DEFAULT_NOW - 1000,
    ...over,
  }
  const path = String(entry.localPath).replace('$DIR/', '')
  return {
    'userData/drive-cache/index.json': JSON.stringify({ entries: [entry] }),
    [path]: dirty ? `${local} edited` : local,
  }
}

/** `md5Of` of the stub, for a text */
const md5 = (text: string): string => md5Of(Buffer.from(text, 'utf8'))

/** what the remote copy of `copy()` is, unless a case says otherwise */
const remoteDoc = (over: Spec = {}): Spec => ({
  name: 'plan.docx',
  mime: DOCX,
  modified: '2026-01-01T00:00:00Z',
  md5: md5('v1'),
  size: 2,
  text: 'v1',
  parents: ['folder-1'],
  ...over,
})

/** the connection comes back from the kept token, so a case starts connected */
const live = (more: World = {}): World => ({ safeStorage: keyring, account: dana, ...more })
const liveFiles = { ...vaultFile(), ...ack }

const doc = (id: string, over: Spec = {}): Spec => ({
  id,
  name: `${id}.docx`,
  mime: DOCX,
  modified: '2026-03-01T10:00:00Z',
  md5: `m-${id}`,
  size: 100,
  text: `body of ${id}`,
  parents: ['folder-1'],
  ...over,
})

const answers = (...responses: number[]) => ({
  dialogs: { message: responses.map((response) => ({ response })) },
})

const cases: Case[] = [
  // ---- the connection: state, connect, disconnect ----
  {
    note: 'no Google client in this build: Drive is not offered, and a connect asks nothing of Google',
    views,
    hosts: hosts({ unavailable: true }),
    files: ack,
    calls: [
      state(),
      docs('drive:connected'),
      docs('drive:ai-enabled'),
      shell('drive:connect'),
      shell('drive:list', { kind: 'recent' }),
      shell('drive:pick-open'),
      shell('drive:set-training-ack', false),
    ],
  },
  {
    note: 'connect needs the training confirmation; no encryption here, so no token is written',
    views,
    hosts: hosts({ account: dana }),
    calls: [
      state(),
      shell('drive:connect'),
      shell('drive:set-training-ack', true),
      shell('drive:connect'),
      shell('drive:state'),
      docs('drive:connected'),
      shell('drive:disconnect'),
      shell('drive:state'),
    ],
  },
  {
    note: 'with encryption the token is kept encrypted, and a disconnect removes it',
    views,
    hosts: hosts({ account: dana, safeStorage: keyring }),
    files: ack,
    calls: [state(), shell('drive:connect'), shell('drive:state'), shell('drive:disconnect')],
  },
  {
    note: 'with encryption the token stays after the connect',
    views,
    hosts: hosts({ account: dana, safeStorage: keyring, token: 'second-token' }),
    files: ack,
    calls: [state(), shell('drive:connect'), docs('drive:connected')],
  },
  {
    note: 'a connect whose account Drive does not tell shows an empty name',
    views,
    hosts: hosts({ safeStorage: keyring }),
    files: ack,
    calls: [state(), shell('drive:connect'), shell('drive:state')],
  },
  {
    note: 'encryption that fails, and a keyring that only looks sealed, keep no token',
    views,
    hosts: hosts({ account: dana, safeStorage: { available: true, failEncrypt: true } }),
    files: { ...ack, ...vaultFile('stale') },
    calls: [state(), shell('drive:connect'), shell('drive:state')],
  },
  {
    note: 'basic_text is no keyring on Linux (the other systems seal with their own store)',
    views,
    hosts: hosts({ account: dana, safeStorage: { available: true, backend: 'basic_text' } }),
    files: ack,
    calls: [state(), shell('drive:connect'), shell('drive:state')],
  },
  {
    note: 'every failure of the browser round, and a success after them, in English',
    views,
    hosts: hosts(
      {
        account: dana,
        connects: ['denied', 'timeout', 'scope', 'cancelled', 'unavailable', 'network', 'ok'],
      },
      { lang: 'en' },
    ),
    files: ack,
    calls: [
      state(),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
    ],
  },
  {
    note: 'Google’s page is opened only at an https address of accounts.google.com',
    views,
    hosts: hosts({
      authUrls: [
        'https://evil.example/o/oauth2',
        'http://accounts.google.com/o/oauth2',
        'javascript:alert(1)',
        'https://accounts.google.com.evil.example/x',
        'https://accounts.google.com/o/oauth2/v2/auth?scope=drive',
      ],
      account: dana,
    }),
    files: ack,
    calls: [
      state(),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
      shell('drive:connect'),
    ],
  },
  {
    note: 'the system refuses to open the browser',
    views,
    hosts: hosts({ account: dana }, {}, { osShell: { openExternalError: 'no browser' } }),
    files: ack,
    calls: [state(), shell('drive:connect'), shell('drive:cancel-connect'), shell('drive:state')],
  },
  {
    note: 'a connect while connected keeps the account on screen',
    views,
    hosts: hosts(live()),
    files: liveFiles,
    calls: [state(), shell('drive:connect'), shell('drive:state')],
  },
  {
    note: 'the kept token brings the connection back at the start, and its account follows',
    views,
    hosts: hosts(live()),
    files: liveFiles,
    calls: [state(), docs('drive:connected'), docs('drive:ai-enabled')],
  },
  {
    note: 'a kept token on a PC that cannot decrypt it now is not used',
    views,
    hosts: hosts({ account: dana }),
    files: { ...vaultFile(), ...ack },
    calls: [state(), docs('drive:connected')],
  },
  {
    note: 'a token that does not decrypt, a damaged file and another version are not used',
    views,
    hosts: hosts({ account: dana, safeStorage: { available: true, failDecrypt: true } }),
    files: { ...vaultFile(), ...ack },
    calls: [state()],
  },
  {
    note: 'a vault file of another version',
    views,
    hosts: hosts({ account: dana, safeStorage: keyring }),
    files: {
      'userData/google-drive.json': JSON.stringify({ version: 2, token: sealed('saved-token') }),
      ...ack,
    },
    calls: [state()],
  },
  {
    note: 'a damaged vault file',
    views,
    hosts: hosts({ account: dana, safeStorage: keyring }),
    files: { 'userData/google-drive.json': '{oops', ...ack },
    calls: [state()],
  },
  {
    note: 'a kept token without a known account',
    views,
    hosts: hosts({ safeStorage: keyring }),
    files: liveFiles,
    calls: [state()],
  },
  {
    note: 'Google ends the grant: the next Drive call finds Drive disconnected, once',
    views,
    hosts: hosts(live({ expireOnApi: true })),
    files: liveFiles,
    calls: [
      state(),
      shell('drive:list', { kind: 'recent' }),
      shell('drive:state'),
      shell('drive:disconnect'),
      shell('drive:state'),
    ],
  },
  {
    note: 'a disconnect removes the kept token and tells every window',
    views,
    hosts: hosts(live()),
    files: liveFiles,
    calls: [state(), shell('drive:disconnect'), docs('drive:connected')],
  },

  // ---- the two switches ----
  {
    note: 'the AI switch and the training confirmation: only true switches them on, the rest of the settings stay',
    views,
    hosts: hosts({}),
    files: settings({ lang: 'ko', driveAiAccess: false }),
    calls: [
      state(),
      shell('drive:set-ai-access', true),
      shell('drive:set-ai-access', 'yes'),
      shell('drive:set-ai-access', { $: 'u' }),
      shell('drive:set-ai-access', true),
      shell('drive:set-training-ack', true),
      shell('drive:set-training-ack', 1),
      shell('drive:set-training-ack', true),
    ],
  },
  {
    note: 'no settings file yet: the AI is on, the confirmation not given',
    views,
    hosts: hosts({ account: dana }),
    calls: [state(), shell('drive:set-ai-access', false), shell('drive:state')],
  },
  {
    note: 'an unwritable settings file',
    views,
    hosts: hosts({}),
    files: { 'userData/app-settings.json': { dir: true } },
    calls: [state(), shell('drive:set-ai-access', false), shell('drive:set-training-ack', true)],
  },

  // ---- the list ----
  {
    note: 'the recent files and searches as the screen sees them, and every refusal',
    views,
    hosts: hosts(
      live({
        lists: [
          {
            files: [
              doc('d1'),
              doc('d2', {
                name: 'big.pdf',
                size: 5_000_000,
                mime: 'application/pdf',
                canEdit: false,
              }),
              doc('d3', { name: 'sub', mime: FOLDER, size: undefined, md5: undefined }),
              doc('d4', { name: 'Notes', mime: GDOC, size: undefined, md5: undefined }),
              doc('d5', { name: 'Budget', mime: GSHEET, size: undefined, md5: undefined }),
              doc('d6', { name: 'tool.exe', mime: 'application/octet-stream' }),
              doc('d7', {
                name: 'to docs',
                mime: SHORTCUT,
                shortcut: { id: 'target-7', mime: FOLDER },
              }),
              doc('d8', {
                name: 'to plan',
                mime: SHORTCUT,
                shortcut: { id: 'target-8', mime: DOCX },
              }),
              doc('d9', { name: 'mind.xmind', mime: 'application/octet-stream' }),
              doc('d10', { name: 'page.HTML', mime: 'text/html', size: undefined }),
            ],
            next: 'page-2',
          },
          { files: [], next: '' },
          { files: [doc('d11')] },
          { error: 'rate-limit' },
          { error: 'network' },
          { error: 'forbidden' },
          { error: 'not-found' },
        ],
      }),
    ),
    files: liveFiles,
    calls: [
      state(),
      shell('drive:list', { kind: 'recent' }),
      shell('drive:list', { kind: 'search', text: '  report  ' }),
      shell('drive:list', { kind: 'search', text: `${'x'.repeat(190)}${'あ'.repeat(30)}` }),
      shell('drive:list', { kind: 'recent' }, 'page-2'),
      shell('drive:list', { kind: 'recent' }, 'x'.repeat(2000)),
      shell('drive:list', { kind: 'recent' }, 7),
      shell('drive:list', { kind: 'recent' }, 'y'.repeat(1999)),
      shell('drive:list', null),
      shell('drive:list', { kind: 'search', text: '   ' }),
      shell('drive:list', { kind: 'search', text: 5 }),
      shell('drive:list', { kind: 'other' }),
      shell('drive:list', 'recent'),
      shell('drive:list'),
      shell('drive:list', { kind: 'recent' }),
    ],
  },
  {
    note: 'a list while no Drive is connected',
    views,
    hosts: hosts({ account: dana }),
    calls: [state(), shell('drive:list', { kind: 'recent' })],
  },

  // ---- open ----
  {
    note: 'only a Drive file id is opened',
    views,
    hosts: hosts(live({ files: { 'a-1_B': doc('a-1_B') } })),
    files: liveFiles,
    calls: [
      state(),
      shell('drive:open', ''),
      shell('drive:open', 'a b'),
      shell('drive:open', '../x'),
      shell('drive:open', 'x'.repeat(201)),
      shell('drive:open', 42),
      shell('drive:open', null),
      shell('drive:open'),
      shell('drive:open', 'a-1_B'),
    ],
  },
  {
    note: 'files open as local copies: a download, an export, a shortcut, and every failure; a second open of a current copy fetches nothing',
    views,
    hosts: hosts(
      live({
        step: 7,
        files: {
          f1: doc('f1', { name: 'Plan: Q1/Q2?.docx', parents: [] }),
          g1: doc('g1', { name: 'Notes', mime: GDOC, size: undefined, md5: undefined }),
          s1: doc('s1', { name: 'link', mime: SHORTCUT, shortcut: { id: 'f2', mime: DOCX } }),
          f2: doc('f2', { name: 'target.docx', text: 'target bytes' }),
          s2: doc('s2', { name: 'dangling', mime: SHORTCUT, shortcut: { id: 'gone', mime: DOCX } }),
          e1: doc('e1', { name: 'tool.exe', mime: 'application/octet-stream' }),
          fo: doc('fo', { name: 'folder', mime: FOLDER }),
          p1: doc('p1', { fileError: 'forbidden' }),
          p2: doc('p2', { downloadError: 'network' }),
          p3: doc('p3', { name: 'sheet', mime: GSHEET, exportError: 'too-large' }),
          p4: doc('p4', { downloadError: 'rate-limit' }),
          com: doc('com', { name: 'con.docx' }),
          dots: doc('dots', { name: `${'x'.repeat(130)}.docx` }),
        },
      }),
    ),
    files: liveFiles,
    calls: [
      state(),
      shell('drive:open', 'f1'),
      shell('drive:open', 'f1'),
      shell('drive:open', 'g1'),
      shell('drive:open', 's1'),
      shell('drive:open', 's2'),
      shell('drive:open', 'e1'),
      shell('drive:open', 'fo'),
      shell('drive:open', 'p1'),
      shell('drive:open', 'p2'),
      shell('drive:open', 'p3'),
      shell('drive:open', 'p4'),
      shell('drive:open', 'missing'),
      shell('drive:open', 'com'),
      shell('drive:open', 'dots'),
    ],
  },
  {
    note: 'no tab can open the copy',
    views,
    hosts: hosts(live({ openPath: false, files: { f1: doc('f1') } })),
    files: liveFiles,
    calls: [state(), shell('drive:open', 'f1')],
  },
  {
    note: 'not connected: an open fails at Drive',
    views,
    hosts: hosts({ files: { f1: doc('f1') } }),
    calls: [state(), shell('drive:open', 'f1')],
  },
  {
    note: 'a current copy is opened as it is, an outdated one is fetched again and the renamed file replaces it',
    views,
    hosts: hosts(
      live({
        files: {
          doc1: remoteDoc({
            modified: '2026-02-02T00:00:00Z',
            name: 'plan v2.docx',
            text: 'v2 from drive',
          }),
        },
      }),
    ),
    files: { ...liveFiles, ...copy() },
    calls: [state(), shell('drive:open', 'doc1'), shell('drive:open', 'doc1')],
  },
  {
    note: 'a copy that a tab shows is not replaced even when Drive has a newer file (the tab is compared without case)',
    views,
    hosts: hosts(
      live({
        openFiles: ['$DIR/userData/drive-cache/doc1/PLAN.docx'],
        files: { doc1: remoteDoc({ modified: '2026-02-02T00:00:00Z', text: 'v2 from drive' }) },
      }),
    ),
    files: { ...liveFiles, ...copy() },
    calls: [state(), shell('drive:open', 'doc1')],
  },
  {
    note: 'a copy that holds changes kept on this PC is not replaced either',
    views,
    hosts: hosts(
      live({
        files: { doc1: remoteDoc({ modified: '2026-02-02T00:00:00Z', text: 'v2 from drive' }) },
      }),
    ),
    files: { ...liveFiles, ...copy({ detached: true }, 'v1', true) },
    calls: [state(), shell('drive:open', 'doc1')],
  },

  // ---- saves that go back to Drive, started by the copies left from last time ----
  {
    note: 'a copy changed on this PC goes up over its Drive file when Drive holds what it was made from',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() } })),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state(), shell('drive:state')],
  },
  {
    note: 'Drive changed too: overwrite',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc({ md5: 'other' }) } }), {}, answers(0)),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'Drive changed too: save a copy, in English',
    views,
    hosts: hosts(
      live({ files: { doc1: remoteDoc({ md5: 'other' }) } }),
      { lang: 'en' },
      answers(1),
    ),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'Drive changed too: keep on this PC only; and an answer outside the buttons is the same',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc({ md5: 'other' }) } }), {}, answers(2)),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'a dialog answer that is no button keeps the change on this PC',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc({ md5: 'other' }) } }), {}, answers(9)),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'without a hash the change time decides: changed',
    views,
    hosts: hosts(
      live({ files: { doc1: remoteDoc({ md5: undefined, modified: '2026-05-05T00:00:00Z' }) } }),
      {},
      answers(0),
    ),
    files: { ...liveFiles, ...copy({ targetMd5: null }, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'a file the account may not edit: save a copy (the button for overwriting is not there)',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc({ canEdit: false }) } }), {}, answers(0)),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'a file gone from Drive: save a copy',
    views,
    hosts: hosts(live({ files: {} }), {}, answers(0)),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'a Google document’s first save makes an Office file beside it',
    views,
    hosts: hosts(live({ files: {} })),
    files: {
      ...liveFiles,
      ...copy(
        {
          sourceId: 'gs1',
          google: true,
          name: 'Budget',
          localPath: `${CACHE}/gs1/Budget.xlsx`,
          targetId: null,
          targetMd5: null,
          targetModified: null,
        },
        'sheet v1',
        true,
      ),
    },
    calls: [state()],
  },
  {
    note: 'no right to add to that folder: My Drive instead',
    views,
    hosts: hosts(live({ files: {}, uploads: [{ error: 'forbidden' }, {}] }), { lang: 'en' }),
    files: {
      ...liveFiles,
      ...copy(
        {
          sourceId: 'gs1',
          google: true,
          name: 'Budget',
          localPath: `${CACHE}/gs1/Budget.xlsx`,
          targetId: null,
          targetMd5: null,
          targetModified: null,
        },
        'sheet v1',
        true,
      ),
    },
    calls: [state()],
  },
  {
    note: 'an upload Drive refuses: the person is told, nothing is retried',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() }, uploads: [{ error: 'too-large' }] })),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'an upload that fails on the network is retried later, and stays on this PC',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() }, uploads: [{ error: 'network' }] })),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'the check of the Drive file fails on the network',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc({ fileError: 'rate-limit' }) } })),
    files: { ...liveFiles, ...copy({}, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'a copy kept on this PC only is not sent again',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() } })),
    files: { ...liveFiles, ...copy({ detached: true }, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'copies not opened for a month are removed unless they hold unsent changes or are open',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() } })),
    files: {
      ...liveFiles,
      ...copy({ openedAt: 1 }),
      'userData/drive-cache/other/readme.txt': 'not in the index',
    },
    calls: [state()],
  },
  {
    note: 'a stale copy that holds unsent changes stays and goes up',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() } })),
    files: { ...liveFiles, ...copy({ openedAt: 1 }, 'v1', true) },
    calls: [state()],
  },
  {
    note: 'a stale copy that a tab shows stays',
    views,
    hosts: hosts(
      live({
        files: { doc1: remoteDoc() },
        openFiles: [`$DIR/userData/drive-cache/doc1/plan.docx`],
      }),
    ),
    files: { ...liveFiles, ...copy({ openedAt: 1 }) },
    calls: [state()],
  },
  {
    note: 'an index entry whose file is gone, one outside the cache, and a damaged entry are dropped',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() } })),
    files: {
      ...liveFiles,
      'userData/drive-cache/index.json': JSON.stringify({
        entries: [
          { sourceId: 'a', localPath: `${CACHE}/a/missing.docx`, syncedSha: 'x' },
          { sourceId: 'b', localPath: '$DIR/elsewhere/b.docx', syncedSha: 'x' },
          { localPath: `${CACHE}/c/c.docx` },
          null,
        ],
      }),
      'elsewhere/b.docx': 'b',
    },
    calls: [state()],
  },
  {
    note: 'a damaged index starts over',
    views,
    hosts: hosts(live({ files: { doc1: remoteDoc() } })),
    files: { ...liveFiles, 'userData/drive-cache/index.json': '{oops' },
    calls: [state()],
  },
  {
    note: 'a save waiting for Drive goes up when Drive comes back',
    views,
    hosts: hosts({ account: dana, safeStorage: keyring, files: { doc1: remoteDoc() } }),
    files: { ...ack, ...copy({}, 'v1', true) },
    calls: [state(), shell('drive:connect'), shell('drive:state')],
  },

  // ---- picking files in Google's picker ----
  {
    note: 'pick and open: some open, the first problem is told',
    views,
    hosts: hosts(
      live({
        picks: [['f1', 'missing', 'e1', 'f2'], [], ['f1']],
        files: {
          f1: doc('f1'),
          f2: doc('f2'),
          e1: doc('e1', { name: 'tool.exe', mime: 'application/octet-stream' }),
        },
      }),
    ),
    files: liveFiles,
    calls: [state(), shell('drive:pick-open'), shell('drive:pick-open'), shell('drive:pick-open')],
  },
  {
    note: 'every way the picker ends without files',
    views,
    hosts: hosts(
      live({ picks: ['cancelled', 'timeout', 'denied', 'scope', 'network', 'unavailable'] }),
    ),
    files: liveFiles,
    calls: [
      state(),
      shell('drive:pick-open'),
      shell('drive:pick-open'),
      shell('drive:pick-open'),
      shell('drive:pick-open'),
      shell('drive:pick-open'),
      shell('drive:pick-open'),
    ],
  },
  {
    note: 'the picker waits for a connection and for the confirmation',
    views,
    hosts: hosts(live()),
    files: vaultFile(),
    calls: [
      state(),
      shell('drive:pick-open'),
      shell('drive:set-training-ack', true),
      shell('drive:pick-open'),
    ],
  },
  {
    note: 'not connected: no picker',
    views,
    hosts: hosts({ account: dana }),
    files: ack,
    calls: [state(), shell('drive:pick-open')],
  },
  {
    note: 'the picker, in English, when the browser cannot be opened',
    views,
    hosts: hosts(live(), { lang: 'en' }, { osShell: { openExternalError: 'no browser' } }),
    files: liveFiles,
    calls: [state(), shell('drive:pick-open')],
  },

  // ---- attaching Drive files to an AI panel ----
  {
    note: 'attachments: old copies are removed first, ids are deduplicated, a shortcut and an export are followed, others are skipped or failed',
    views,
    hosts: hosts(
      live({
        picks: [['f1', 'f1', 'sc1', 'g1', 'e1', 'missing', 'bad']],
        files: {
          f1: doc('f1', { name: 'one.docx' }),
          sc1: doc('sc1', { name: 'link', mime: SHORTCUT, shortcut: { id: 'f9', mime: DOCX } }),
          f9: doc('f9', { name: 'nine.docx', text: 'nine' }),
          g1: doc('g1', { name: 'Notes', mime: GDOC, size: undefined, md5: undefined }),
          e1: doc('e1', { name: 'tool.exe', mime: 'application/octet-stream' }),
          bad: doc('bad', { downloadError: 'forbidden' }),
        },
      }),
    ),
    files: {
      ...liveFiles,
      'temp/seuoffice-drive-attach/old-copy/a.docx': 'old',
      'temp/seuoffice-drive-attach/old-copy': { dir: true, mtimeMs: 1_690_000_000_000 },
      'temp/seuoffice-drive-attach/fresh-copy/b.docx': 'fresh',
      'temp/seuoffice-drive-attach/fresh-copy': { dir: true, mtimeMs: 1_699_900_000_000 },
      'temp/seuoffice-drive-attach/loose.txt': { text: 'loose', mtimeMs: 1_690_000_000_000 },
    },
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'the attachments folder cannot be made',
    views,
    hosts: hosts(live({ picks: [['f1']], files: { f1: doc('f1') } })),
    files: { ...liveFiles, 'temp/seuoffice-drive-attach': 'a file in the way' },
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'more than twenty picks: the rest are skipped',
    views,
    hosts: hosts(
      live({
        picks: [Array.from({ length: 23 }, (_, i) => `u${i + 1}`)],
        files: Object.fromEntries(
          Array.from({ length: 23 }, (_, i) => [
            `u${i + 1}`,
            doc(`u${i + 1}`, {
              name: i % 2 ? 'x.exe' : 'y.pdf',
              mime: i % 2 ? 'a/b' : 'application/pdf',
            }),
          ]),
        ),
      }),
    ),
    files: liveFiles,
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'a free AI is not given Drive files, and nothing is picked for it',
    views,
    hosts: hosts(live({ picks: [['f1']], files: { f1: doc('f1') } })),
    files: {
      ...liveFiles,
      'userData/ai-settings.json': JSON.stringify({ provider: 'gemini', providers: {} }),
    },
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'an OpenRouter model counts as free only with the :free suffix',
    views,
    hosts: hosts(live({ picks: [['f1'], ['f1']], files: { f1: doc('f1') } })),
    files: {
      ...liveFiles,
      'userData/ai-settings.json': JSON.stringify({
        provider: 'openrouter',
        providers: { openrouter: { model: 'meta/llama:free' } },
      }),
    },
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'a paid OpenRouter model may be given Drive files',
    views,
    hosts: hosts(live({ picks: [['f1']], files: { f1: doc('f1') } })),
    files: {
      ...liveFiles,
      'userData/ai-settings.json': JSON.stringify({
        provider: 'openrouter',
        providers: { openrouter: { model: 'openai/gpt-5' } },
      }),
    },
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'the free-AI check only applies to a connection; the picker then says there is none',
    views,
    hosts: hosts({ account: dana }),
    files: {
      ...ack,
      'userData/ai-settings.json': JSON.stringify({ provider: 'gemini', providers: {} }),
    },
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'attaching waits for the confirmation',
    views,
    hosts: hosts(live()),
    files: vaultFile(),
    calls: [docs('drive:connected'), docs('drive:pick-attachments')],
  },
  {
    note: 'a picker that ends without files: cancelled stays, the other failures are told as failed, an empty pick is cancelled',
    views,
    hosts: hosts(
      live({ picks: ['cancelled', 'timeout', 'denied', 'scope', 'network', 'unavailable', []] }),
    ),
    files: liveFiles,
    calls: [
      docs('drive:connected'),
      docs('drive:pick-attachments'),
      docs('drive:pick-attachments'),
      docs('drive:pick-attachments'),
      docs('drive:pick-attachments'),
      docs('drive:pick-attachments'),
      docs('drive:pick-attachments'),
      docs('drive:pick-attachments'),
    ],
  },

  // ---- the AI's Drive tools ----
  {
    note: 'the AI may use Drive only when connected, switched on and confirmed',
    views,
    hosts: hosts(live()),
    files: liveFiles,
    calls: [docs('drive:ai-enabled')],
  },
  {
    note: 'the AI switch is off',
    views,
    hosts: hosts(live()),
    files: { ...vaultFile(), ...settings({ driveTrainingAck: true, driveAiAccess: false }) },
    calls: [
      docs('drive:ai-enabled'),
      docs('drive:ai-search', { q: 'plan' }),
      docs('drive:ai-read', { id: 'f1' }),
    ],
  },
  {
    note: 'no confirmation: the AI has no Drive',
    views,
    hosts: hosts(live()),
    files: vaultFile(),
    calls: [docs('drive:ai-enabled'), docs('drive:ai-search', { q: 'plan' })],
  },
  {
    note: 'not connected: the AI has no Drive',
    views,
    hosts: hosts({ account: dana }),
    files: ack,
    calls: [docs('drive:ai-enabled'), docs('drive:ai-read', { id: 'f1' })],
  },
  {
    note: 'a free AI is refused before anything is fetched',
    views,
    hosts: hosts(live()),
    files: {
      ...liveFiles,
      'userData/ai-settings.json': JSON.stringify({ provider: 'gemini', providers: {} }),
    },
    calls: [
      docs('drive:ai-enabled'),
      docs('drive:ai-search', { q: 'plan' }),
      docs('drive:ai-read', { id: 'f1' }),
    ],
  },
  {
    note: 'a search: the limit, the text and what Drive answers',
    views,
    hosts: hosts(
      live({
        lists: [
          {
            files: [
              doc('s1'),
              doc('s2', { name: 'sheet.xlsx' }),
              doc('s3', { name: 'deck.pptx' }),
              doc('s4', { name: 'a.pdf', mime: 'application/pdf' }),
              doc('s5', { name: 'a.md' }),
              doc('s6', { name: 'a.html' }),
              doc('s7', { name: 'a.xmind' }),
              doc('s8', { name: 'a.hwpx' }),
              doc('s9', { name: 'a.epub' }),
              doc('s10', { name: 'a.drawio' }),
              doc('s11', { name: 'a.csv' }),
              doc('s12', { name: 'dir', mime: FOLDER }),
              doc('s13', { name: 'a.exe' }),
              doc('s14', { name: 'Doc', mime: GDOC }),
              doc('s15', { name: 'Sheet', mime: GSHEET }),
            ],
          },
          { files: [doc('s1'), doc('s2'), doc('s3'), doc('s4')] },
          { files: [doc('s1'), doc('s2'), doc('s3'), doc('s4')] },
          { files: [doc('s1')] },
          { files: [doc('s1')] },
          { error: 'not-connected' },
          { error: 'rate-limit' },
          { error: 'forbidden' },
          { error: 'too-large' },
          { error: 'network' },
          { error: 'not-found' },
        ],
      }),
    ),
    files: liveFiles,
    calls: [
      docs('drive:ai-enabled'),
      docs('drive:ai-search', { q: 'plan' }),
      docs('drive:ai-search', { q: '  quarterly  ', limit: 3 }),
      docs('drive:ai-search', { q: `${'z'.repeat(250)}`, limit: 3.9 }),
      docs('drive:ai-search', { q: 'a', limit: 0 }),
      docs('drive:ai-search', { q: 'a', limit: 99 }),
      docs('drive:ai-search', { q: 'a', limit: -4 }),
      docs('drive:ai-search', { q: 'a', limit: '5' }),
      docs('drive:ai-search', { q: 'a', limit: 'many' }),
      docs('drive:ai-search', { q: 'a' }),
      docs('drive:ai-search', { q: 'a' }),
      docs('drive:ai-search', { q: '' }),
      docs('drive:ai-search', { q: '   ' }),
      docs('drive:ai-search', { q: 7 }),
      docs('drive:ai-search', null),
      docs('drive:ai-search'),
      docs('drive:ai-search', 'plan'),
    ],
  },
  {
    note: 'a read: pages of the parsed text, the offset, errors and the cache',
    views,
    hosts: hosts(
      live({
        step: 400_000,
        files: {
          a1: doc('a1', { name: 'long.docx' }),
          sc: doc('sc', { name: 'link', mime: SHORTCUT, shortcut: { id: 'a1', mime: DOCX } }),
          scx: doc('scx', {
            name: 'link',
            mime: SHORTCUT,
            shortcut: { id: 'nowhere', mime: DOCX },
          }),
          fo: doc('fo', { name: 'folder', mime: FOLDER }),
          ex: doc('ex', { name: 'tool.exe', mime: 'a/b' }),
          g1: doc('g1', { name: 'Notes', mime: GDOC, size: undefined, md5: undefined }),
          e1: doc('e1', { downloadError: 'too-large' }),
          e2: doc('e2', { downloadError: 'forbidden' }),
          e3: doc('e3', { fileError: 'rate-limit' }),
          e4: doc('e4', { fileError: 'network' }),
          e5: doc('e5', { fileError: 'not-found' }),
          u1: doc('u1', { name: 'scan.pdf', mime: 'application/pdf' }),
          u2: doc('u2', { name: 'broken.docx' }),
          u3: doc('u3', { name: 'image.docx' }),
        },
        parse: {
          'long.docx': { ok: true, kind: 'text', text: `😀 ${'abc '.repeat(7000)}end` },
          'Notes.docx': { ok: true, kind: 'text', text: 'exported notes' },
          'scan.pdf': { ok: true, kind: 'image', text: 'x' },
          'broken.docx': { ok: false },
          'image.docx': { ok: true, kind: 'text' },
        },
      }),
    ),
    files: liveFiles,
    calls: [
      docs('drive:ai-enabled'),
      docs('drive:ai-read', { id: 'a1' }),
      docs('drive:ai-read', { id: 'a1', offset: 24_000 }),
      docs('drive:ai-read', { id: 'a1', offset: 1e9 }),
      docs('drive:ai-read', { id: 'a1', offset: -5 }),
      docs('drive:ai-read', { id: 'a1', offset: '12' }),
      docs('drive:ai-read', { id: 'a1', offset: 'x' }),
      docs('drive:ai-read', { id: 'a1', offset: 10.7 }),
      docs('drive:ai-read', { id: 'sc' }),
      docs('drive:ai-read', { id: 'scx' }),
      docs('drive:ai-read', { id: 'fo' }),
      docs('drive:ai-read', { id: 'ex' }),
      docs('drive:ai-read', { id: 'g1' }),
      docs('drive:ai-read', { id: 'e1' }),
      docs('drive:ai-read', { id: 'e2' }),
      docs('drive:ai-read', { id: 'e3' }),
      docs('drive:ai-read', { id: 'e4' }),
      docs('drive:ai-read', { id: 'e5' }),
      docs('drive:ai-read', { id: 'u1' }),
      docs('drive:ai-read', { id: 'u2' }),
      docs('drive:ai-read', { id: 'u3' }),
      docs('drive:ai-read', { id: 'bad id' }),
      docs('drive:ai-read', { id: '' }),
      docs('drive:ai-read', { id: 5 }),
      docs('drive:ai-read', null),
      docs('drive:ai-read'),
    ],
  },
  {
    note: 'what the AI read is forgotten when Drive disconnects; the cache ends after ten minutes',
    views,
    hosts: hosts(live({ step: 250_000, files: { a1: doc('a1') }, picks: [] })),
    files: liveFiles,
    calls: [
      docs('drive:ai-enabled'),
      docs('drive:ai-read', { id: 'a1' }),
      docs('drive:ai-read', { id: 'a1' }),
      docs('drive:ai-read', { id: 'a1' }),
      shell('drive:disconnect'),
      shell('drive:connect'),
      docs('drive:ai-read', { id: 'a1' }),
      docs('drive:ai-read', { id: 'a1' }),
    ],
  },
  {
    note: 'a changed file is read again; the cache holds four texts',
    views,
    hosts: hosts(
      live({
        files: Object.fromEntries(['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => [id, doc(id)])),
      }),
    ),
    files: liveFiles,
    calls: [
      docs('drive:ai-enabled'),
      ...['r1', 'r2', 'r3', 'r4', 'r5', 'r1', 'r5'].map((id) => docs('drive:ai-read', { id })),
    ],
  },
]

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const world = (cx.case.hosts?.a as { drive?: World } | undefined)?.drive ?? null
    const hostsA = (cx.case.hosts?.a ?? {}) as { lang?: string }
    const shared = (cx.case.hosts?.shared ?? {}) as {
      mainWindow?: { view?: number; window?: number }
    }
    // what the previous case left running is stopped
    ;(box as { service?: { stop(): void } }).service?.stop()
    box.world = world
    box.log = cx.electron.log
    box.clock = world?.now ?? DEFAULT_NOW
    box.folders = 0
    const storage = world?.safeStorage ?? {}
    box.safeStorage = {
      isEncryptionAvailable: () => storage.available === true,
      encryptString: (text: string) => {
        if (storage.failEncrypt) throw new Error('encrypt failed')
        return Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a))
      },
      decryptString: (bytes: Buffer) => {
        if (storage.failDecrypt) throw new Error('decrypt failed')
        return Buffer.from(Buffer.from(bytes).map((b) => b ^ 0x5a)).toString('utf8')
      },
      getSelectedStorageBackend: () => storage.backend ?? 'gnome_libsecret',
    }
    const g = globalThis as Record<string, unknown>
    if (world && !world.unavailable) {
      g.__SEUOFFICE_GOOGLE_CLIENT_ID__ = 'seuoffice-test.apps.googleusercontent.com'
      g.__SEUOFFICE_GOOGLE_CLIENT_SECRET__ = 'test-secret'
    } else {
      delete g.__SEUOFFICE_GOOGLE_CLIENT_ID__
      delete g.__SEUOFFICE_GOOGLE_CLIENT_SECRET__
    }

    // the shell window dialogs attach to: what the Rust fake's main-window host answers
    const views = cx.case.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
    const main =
      typeof shared.mainWindow?.view === 'number' && typeof shared.mainWindow.window === 'number'
        ? views.find(
            (v) =>
              v.view === shared.mainWindow?.view &&
              (v.window ?? v.view) === shared.mainWindow?.window,
          )
        : views.find((v) => (v.surface ?? 'Shell') === 'Shell')
    const windows = cx.electron.BrowserWindow as { fromId(id: number): unknown }
    const shellWindow = main ? windows.fromId(main.window ?? main.view) : null

    const mod = await cx.fresh<DriveIpc>(MODULE)
    runWith(entryCode, {
      readFileSync,
      join,
      resolve,
      normalizeAiSettings,
      app: cx.electron.app,
      currentLang: () => hostsA.lang ?? 'ko',
      shellWindow,
      routeDocumentPath: (path: string) => {
        cx.electron.log.push(['routeDocumentPath', path])
        return world?.openPath !== false
      },
      tabManager: {
        openFilePaths: () => world?.openFiles ?? [],
        describeWebContents: () => null,
      },
      parseFileToText: async (path: string) => {
        const bytes = readFileSync(path)
        const name = basename(path)
        cx.electron.log.push(['parseFileToText', name, bytes.toString('hex')])
        const given = world?.parse?.[name]
        if (given) return { ok: given.ok ?? false, kind: given.kind, text: given.text }
        return { ok: true, kind: 'text', text: bytes.toString('utf8') }
      },
      freeAiInUse,
      registerDriveIpc: (deps: Parameters<DriveIpc['registerDriveIpc']>[0]) => {
        const service = mod.registerDriveIpc(deps)
        ;(box as { service?: { stop(): void } }).service = service
        return service
      },
      driveService: undefined,
    })
    // every handler answers once the disk work it started is done
    const invoke = cx.electron.handlers.invoke
    for (const [channel, handler] of [...invoke]) {
      invoke.set(channel, async (...args: unknown[]) => {
        try {
          return await handler(...args)
        } finally {
          await quiet()
        }
      })
    }
    await quiet()
  },
  cases,
}
