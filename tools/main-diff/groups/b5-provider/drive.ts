/**
 * Group `b5-provider`, part `drive` (Rust: crates/main-core/src/calls/b5_provider/drive.rs):
 * `packages/google-drive/src`: formats.ts, drive-api.ts, oauth.ts and
 * connection.ts. The functions that await run in the scripted world of
 * world.ts (a case is `[world, options]`).
 *
 * Case options (`A`): the call's own inputs (`id`, `maxBytes`, `mime`,
 * `listing`, `options`, `target`, `bytes` as hex, `code`, `verifier`, `port`,
 * `token`) and
 * - `download`: the DriveApi / DriveConnection gets a separate download fetch (`net`)
 * - `noSignal`: the DriveApi call gets no signal; `useSignal`: the oauth call
 *   gets the caller's signal (the world's `abortAt` aborts it)
 * - `nowSeq`: the clock the call is given answers these values in turn, the
 *   last one again and again; none: `Date.now` (the world's clock)
 * - `noFetch`, `timeoutMs`, `pick`, `pages`, `client` (`null`: a build without
 *   a Google client) of the sign-in and the connection
 * - `steps`: what a DriveConnection does, in order: `load`, `state`, `connected`,
 *   `connect`, `pick` (`multiple`), `cancelConnect`, `disconnect`, `onChange`
 *   (`name`), `offChange` (`name`), `sleep` (`ms`), `settle` (a timer of 0 ms:
 *   it fires once nothing else can run), `api.account`, `api.file` (`id`),
 *   `seq` (`steps`, one after the other) and `parallel` (`steps`, `Promise.all`).
 *   Its answer is the list of the steps' answers.
 *
 * The caller's functions are the world's calls, by name: `openBrowser(url)`
 * and the vault's `vault.load()`, `vault.save(token)`, `vault.clear()`, whose
 * answers `calls` lists in the order they are asked. A listener of
 * `onChange` logs `['state', name, state]`; a DriveApi's token source logs
 * `['token', 'signal' | 'none']`.
 */
import '../../electron-fake.ts'
import type { Case, Group, TsContext } from '../../types.ts'
import { inWorld, type World, type WorldRun } from './world.ts'

// loaded after electron-fake.ts has registered its hooks, as every group
// loads the modules under test: a static import would resolve before them
const formats = await import('../../../../packages/google-drive/src/formats.ts')
const driveApi = await import('../../../../packages/google-drive/src/drive-api.ts')
const oauth = await import('../../../../packages/google-drive/src/oauth.ts')
const connection = await import('../../../../packages/google-drive/src/connection.ts')

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Step {
  do: string
  [key: string]: unknown
}

interface A {
  token?: string | null
  download?: boolean
  id?: string
  maxBytes?: number
  mime?: string
  listing?: Any
  options?: Any
  target?: Any
  bytes?: string
  noSignal?: boolean
  useSignal?: boolean
  nowSeq?: number[]
  noFetch?: boolean
  timeoutMs?: number
  pick?: { multiple: boolean }
  pages?: Any
  client?: { clientId: string; clientSecret: string } | null
  code?: string
  verifier?: string
  port?: number
  times?: number
  steps?: Step[]
}

const CLIENT = { clientId: 'cid', clientSecret: 'sec' }
const PAGES = {
  done: { lang: 'en', title: 'Signed in', body: 'You can close this tab.' },
  failed: { lang: 'en', title: 'Not signed in', body: 'Try again.' },
}

const c = (...args: unknown[]): Case => ({ args })
const w = (fetches: unknown[], more: Partial<World> = {}): World => ({ fetches, ...more }) as World
const ok = (body: unknown[] | null, headers: [string, string][] = [], status = 200) => ({
  status,
  headers,
  body,
})
const json = (value: unknown, status = 200, headers: [string, string][] = []) =>
  ok([JSON.stringify(value)], [['content-type', 'application/json'], ...headers], status)

const clockOf = (seq: number[] | undefined): (() => number) | undefined => {
  if (!seq) return undefined
  let k = 0
  return () => seq[Math.min(k++, seq.length - 1)]
}

const bytesOfHex = (hex: string | undefined): Uint8Array =>
  new Uint8Array(Buffer.from(hex ?? '', 'hex'))

/** a result with its bytes as hex */
const shown = (r: Any): unknown =>
  r && r.ok && r.bytes ? { ...r, bytes: { hex: Buffer.from(r.bytes).toString('hex') } } : r

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const DOC = 'application/vnd.google-apps.document'
const SHEET = 'application/vnd.google-apps.spreadsheet'
const SLIDES = 'application/vnd.google-apps.presentation'
const FORM = 'application/vnd.google-apps.form'
const FOLDER = 'application/vnd.google-apps.folder'
const SHORTCUT = 'application/vnd.google-apps.shortcut'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

const FILE = {
  id: 'f1',
  name: 'Report.docx',
  mimeType: DOCX,
  modifiedTime: '2026-01-02T03:04:05.000Z',
  size: '2048',
  md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
  parents: ['root1'],
  capabilities: { canEdit: true },
}

const TOKEN = (extra: Record<string, unknown> = {}) =>
  json({ access_token: 'at1', expires_in: 3600, ...extra })
const SIGNED_IN = json({
  access_token: 'at1',
  refresh_token: 'rt-new',
  expires_in: 3600,
  scope: `email ${SCOPE}`,
})
const ABOUT = json({ user: { displayName: 'Kim', emailAddress: 'kim@example.com' } })
const REVOKED = json({ error: 'invalid_grant', error_description: 'Token has been revoked' }, 400)
const e403 = (body: unknown) => json(body, 403)
const LOCATION: [string, string][] = [
  ['Location', `${UPLOAD}/files?uploadType=resumable&upload_id=u1`],
]

/** the browser coming back to the loopback address: the code and the state of the n-th call */
const back = (afterCall: number, query = 'code=c1', more: Record<string, unknown> = {}) => ({
  afterCall,
  url: `/callback?${query}&state=$state`,
  ...more,
})

// ---------------------------------------------------------------------------
// formats.ts and the pure functions of drive-api.ts and oauth.ts
// ---------------------------------------------------------------------------

const constant = (ts: () => unknown): Group[string] => ({
  single: 'a constant',
  ts,
  cases: [c()],
})

const pure: Group = {
  'formats.FOLDER_MIME': constant(() => formats.FOLDER_MIME),
  'formats.SHORTCUT_MIME': constant(() => formats.SHORTCUT_MIME),
  'formats.GOOGLE_EXPORTS': constant(() => formats.GOOGLE_EXPORTS),
  'formats.OPENABLE_EXTENSIONS': constant(() => formats.OPENABLE_EXTENSIONS),
  'drive-api.DRIVE_API': constant(() => driveApi.DRIVE_API),
  'drive-api.DRIVE_UPLOAD_API': constant(() => driveApi.DRIVE_UPLOAD_API),
  'drive-api.MAX_OPEN_BYTES': constant(() => driveApi.MAX_OPEN_BYTES),
  'drive-api.MAX_READ_BYTES': constant(() => driveApi.MAX_READ_BYTES),
  'oauth.GOOGLE_AUTH_URL': constant(() => oauth.GOOGLE_AUTH_URL),
  'oauth.GOOGLE_TOKEN_URL': constant(() => oauth.GOOGLE_TOKEN_URL),
  'oauth.GOOGLE_REVOKE_URL': constant(() => oauth.GOOGLE_REVOKE_URL),
  'oauth.DRIVE_SCOPE': constant(() => oauth.DRIVE_SCOPE),
  'oauth.MAX_PICKED_FILES': constant(() => oauth.MAX_PICKED_FILES),
  'oauth.GOOGLE_SIGN_IN_TIMEOUT_MS': constant(() => oauth.GOOGLE_SIGN_IN_TIMEOUT_MS),

  'formats.isGoogleNative': {
    ts: ([mime]) => formats.isGoogleNative(mime as string),
    cases: [
      c(DOC),
      c(FOLDER),
      c('application/pdf'),
      c('application/vnd.google-apps.'),
      c('Application/vnd.google-apps.document'),
      c('application/vnd.google-apps'),
      c(''),
    ],
  },
  'formats.extensionOf': {
    ts: ([name]) => formats.extensionOf(name as string),
    cases: [
      c('Report.docx'),
      c('REPORT.DOCX'),
      c('.hidden'),
      c('noext'),
      c('a.b.c'),
      c('trailing.'),
      c(''),
      c('dir.d/file'),
      c('a.\u0130X'),
      c('가나.Md'),
      c('x. docx'),
    ],
  },
  'formats.openPlan': {
    ts: ([file]) => formats.openPlan(file as { name: string; mimeType: string }),
    cases: [
      c({ name: 'Doc', mimeType: DOC }),
      c({ name: 'Sheet', mimeType: SHEET }),
      c({ name: 'Slides', mimeType: SLIDES }),
      c({ name: 'Form', mimeType: FORM }),
      c({ name: 'Folder', mimeType: FOLDER }),
      c({ name: 'Link.pdf', mimeType: SHORTCUT }),
      c({ name: 'a.pdf', mimeType: 'application/pdf' }),
      c({ name: 'A.PDF', mimeType: 'application/octet-stream' }),
      c({ name: 'a.xlsm', mimeType: 'x/y' }),
      c({ name: 'diagram.DrawIO', mimeType: 'x/y' }),
      c({ name: 'a.exe', mimeType: 'application/x-msdownload' }),
      c({ name: '.docx', mimeType: DOCX }),
      c({ name: 'noext', mimeType: 'text/plain' }),
      c({ name: 'a.pdf', mimeType: 'constructor' }),
      c({ name: 'a.pdf', mimeType: '__proto__' }),
      c({ name: 'a.pdf', mimeType: 'toString' }),
      c({ name: 'a.pdf', mimeType: 'hasOwnProperty' }),
      c({ name: 'a.pdf', mimeType: 'Constructor' }),
    ],
  },
  'formats.uploadMime': {
    ts: ([name]) => formats.uploadMime(name as string),
    cases: [
      c('a.docx'),
      c('b.XLSX'),
      c('c.pptx'),
      c('d.pdf'),
      c('e.md'),
      c('f.markdown'),
      c('g.txt'),
      c('h.csv'),
      c('i.html'),
      c('j.htm'),
      c('k.zip'),
      c('noext'),
      c('.md'),
      c(''),
    ],
  },
  'formats.localFileName': {
    ts: ([name, ext]) => formats.localFileName(name as string, ext as string),
    cases: [
      c('Report', '.docx'),
      c('Report.docx', '.docx'),
      c('REPORT.DOCX', '.docx'),
      c('a.xlsx', '.docx'),
      c('a<b>c:d"e/f\\g|h?i*j', '.docx'),
      c('tab\tand\u0001ctl\u007f\u0085x', '.xlsx'),
      c('name. . .', '.docx'),
      c('  spaced  ', '.docx'),
      c('nbsp\u00a0', '.docx'),
      c('CON', '.docx'),
      c('con.docx', '.docx'),
      c('Nul', '.pptx'),
      c('com1', '.docx'),
      c('Com0', '.docx'),
      c('lpt9.xlsx', '.xlsx'),
      c('lpt10', '.docx'),
      c('comma', '.docx'),
      c('', '.docx'),
      c('...', '.docx'),
      c('.docx', '.docx'),
      c('가'.repeat(130), '.docx'),
      c('\u{1F600}'.repeat(70), '.docx'),
      c('abc', ''),
      c('a.b', ''),
      c('a.docx.docx', '.docx'),
    ],
  },
  'formats.officeCopyName': {
    ts: ([name, ext]) => formats.officeCopyName(name as string, ext as string),
    cases: [
      c('a.docx', '.docx'),
      c('a', '.docx'),
      c('a.DOCX', '.docx'),
      c('Report.v2', '.docx'),
      c('Budget.xlsx', '.docx'),
      c('', '.pptx'),
    ],
  },
  'drive-api.queryLiteral': {
    ts: ([value]) => driveApi.queryLiteral(value as string),
    cases: [
      c('plain'),
      c("it's"),
      c('a\\b'),
      c("\\'"),
      c("''"),
      c(''),
      c("x' or name contains 'y"),
      c('가 name'),
    ],
  },
  'drive-api.listingQuery': {
    ts: ([listing]) => driveApi.listingQuery(listing as Any),
    cases: [
      c({ kind: 'recent' }),
      c({ kind: 'search', text: 'budget' }),
      c({ kind: 'search', text: "o'brien" }),
      c({ kind: 'search', text: '' }),
      c({ kind: 'search', text: '\\' }),
    ],
  },
  'oauth.redirectUri': {
    ts: ([port]) => oauth.redirectUri(port as number),
    cases: [c(8080), c(0), c(65535), c(1.5), c(40001)],
  },
  'oauth.googleAuthUrl': {
    ts: ([id, port, challenge, state, pick]) =>
      oauth.googleAuthUrl(
        id as string,
        port as number,
        challenge as string,
        state as string,
        pick as Any,
      ),
    cases: [
      c('cid', 40001, 'chal', 'st'),
      c('cid', 40001, 'chal', 'st', { multiple: false }),
      c('cid', 40001, 'chal', 'st', { multiple: true }),
      c('a b&c=d', 1, 'x+y/z=', 'é가', undefined),
      c('', 0, '', ''),
    ],
  },
  'oauth.pickedFileIds': {
    ts: ([raw]) => oauth.pickedFileIds(raw as string | null),
    cases: [
      c(null),
      c(''),
      c('a'),
      c('a,b,c'),
      c(' a , b '),
      c('a,a,b,a'),
      c('a b,a/b,,ok,é,a-b_c'),
      c('x'.repeat(200)),
      c('x'.repeat(201)),
      c(Array.from({ length: 60 }, (_, i) => `id${i}`).join(',')),
      c(Array.from({ length: 49 }, (_, i) => `id${i}`).join(',') + ',id0,last,more'),
      c('a\nb,\tc\t,\u00a0d'),
      c(',,,'),
    ],
  },
  'oauth.signInPageHtml': {
    ts: ([page]) => oauth.signInPageHtml(page as Any),
    cases: [
      c(PAGES.done),
      c({ lang: 'ko', title: '<b>제목</b>', body: `it's "quoted" & <tagged>` }),
      c({ lang: '"><script>', title: '', body: '' }),
    ],
  },
}

// ---------------------------------------------------------------------------
// DriveApi
// ---------------------------------------------------------------------------

function apiOf(run: WorldRun, o: A): Any {
  return new driveApi.DriveApi({
    token: async (signal?: AbortSignal) => {
      run.log('token', signal ? 'signal' : 'none')
      return o.token === undefined ? 'tok' : o.token
    },
    fetch: run.fetch('node'),
    download: o.download ? run.fetch('net') : undefined,
  })
}

/** a DriveApi call in the case's world */
function api(call: (api: Any, o: A, signal: AbortSignal | undefined) => Promise<unknown>) {
  return ([world, o]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (run, signal) => {
      const opts = (o ?? {}) as A
      return shown(await call(apiOf(run, opts), opts, opts.noSignal ? undefined : signal))
    })
}

const r403 = (reason: unknown) => e403({ error: { errors: [{ reason }] } })
const upload = (location: [string, string][] = LOCATION) => [
  ok([], location),
  json({ ...FILE, id: 'new1' }),
]
const bytes = (hex: string) => ({ bytes: hex })

const account: Group = {
  'drive-api.DriveApi.account': {
    ts: api((a, _o, signal) => a.account(signal)),
    cases: [
      c(w([ABOUT])),
      c(w([json({ user: { displayName: 'Kim' } })])),
      c(w([json({ user: { displayName: 3, emailAddress: null } })])),
      c(w([json({ user: null })])),
      c(w([json({})])),
      c(w([json([])])),
      c(w([json('text')])),
      c(w([ok(['not json'])])),
      c(w([ok(null)])),
      c(w([json(null)])),
      c(w([ABOUT]), { noSignal: true }),
      c(w([ABOUT]), { token: null }),
      c(w([ABOUT]), { token: '' }),
      c(w([ABOUT]), { token: 'bad\ntoken' }),
      c(w([ABOUT]), { token: 'bad\u00e9\u0100' }),
      c(w([ABOUT]), { token: ' spaced ' }),
      c(w([ok([], [], 401)])),
      c(w([ok([], [], 404)])),
      c(w([ok([], [], 429)])),
      c(w([ok(['oops'], [], 500)])),
      c(w([ok(['moved'], [['Location', 'https://x.example/']], 302)])),
      c(w([r403('userRateLimitExceeded')])),
      c(w([r403('rateLimitExceeded')])),
      c(w([r403('exportSizeLimitExceeded')])),
      c(w([r403('downloadQuotaExceeded')])),
      c(w([e403({ error: { errors: [{ reason: 'x' }, { reason: 'rateLimitExceeded' }] } })])),
      c(w([e403({ error: { errors: [] } })])),
      c(w([e403({ error: {} })])),
      c(w([e403({ error: null })])),
      c(w([e403({})])),
      c(w([e403([])])),
      c(w([e403('forbidden')])),
      c(w([ok(['<html>no</html>'], [], 403)])),
      c(w([ok(null, [], 403)])),
      c(w([e403(null)])),
      c(w([e403({ error: { errors: 'rateLimitExceeded' } })])),
      c(w([e403({ error: { errors: [null] } })])),
      c(w([e403({ error: { errors: [5, 'x'] } })])),
      c(w([e403({ error: { errors: { reason: 'rateLimitExceeded' } } })])),
      c(w([{ reject: { message: 'socket hang up' } }])),
      c(w([{ reject: { class: 'DOMException', name: 'AbortError', message: 'aborted' } }])),
      c(w([{ hang: true }])),
      c(w([{ hang: true }], { abortAt: 100 })),
      c(w([])),
      c(w([ok([{ error: 'stream cut' }])])),
    ],
  },
}

const lists: Group = {
  'drive-api.DriveApi.list': {
    ts: api((a, o, signal) => a.list(o.listing, o.options ?? {}, signal)),
    cases: [
      c(w([json({ files: [FILE], nextPageToken: 'next1' })]), { listing: { kind: 'recent' } }),
      c(w([json({ files: [] })]), { listing: { kind: 'search', text: "o'brien \\ \u0020x" } }),
      c(w([json({ files: [FILE] })]), {
        listing: { kind: 'recent' },
        options: { pageToken: 'tok/1=', pageSize: 5000 },
      }),
      c(w([json({ files: [FILE] })]), {
        listing: { kind: 'recent' },
        options: { pageSize: 0 },
      }),
      c(w([json({ files: [FILE] })]), {
        listing: { kind: 'recent' },
        options: { pageSize: -7, pageToken: '' },
      }),
      c(w([json({ files: [FILE] })]), {
        listing: { kind: 'search', text: 'a' },
        options: { pageSize: 2.5 },
      }),
      c(w([json({})]), { listing: { kind: 'recent' }, options: {} }),
      c(w([json({ files: null, nextPageToken: 5 })]), { listing: { kind: 'recent' } }),
      c(w([json({ files: [{ id: 'x' }, { id: 1, name: 'n', mimeType: 'm' }, 'text', 4, []] })]), {
        listing: { kind: 'recent' },
      }),
      c(
        w([
          json({
            files: [
              { id: 'a', name: 'a', mimeType: 'text/plain' },
              { id: 'b', name: 'b', mimeType: 'm', size: '12', modifiedTime: 5 },
              { id: 'c', name: 'c', mimeType: 'm', size: 'abc' },
              { id: 'd', name: 'd', mimeType: 'm', size: '-1' },
              { id: 'e', name: 'e', mimeType: 'm', size: '1e3', md5Checksum: 7 },
              { id: 'f', name: 'f', mimeType: 'm', size: '', parents: ['p', 3, 'q'] },
              { id: 'g', name: 'g', mimeType: 'm', size: 12, parents: 'p' },
              { id: 'h', name: 'h', mimeType: 'm', size: '0x10', capabilities: { canEdit: false } },
              { id: 'i', name: 'i', mimeType: 'm', capabilities: 'yes' },
              { id: 'j', name: 'j', mimeType: 'm', capabilities: null },
              { id: 'k', name: 'k', mimeType: 'm', capabilities: { canEdit: 1 } },
              { id: 'l', name: 'l', mimeType: 'm', size: ' 7 ' },
            ],
          }),
        ]),
        { listing: { kind: 'recent' } },
      ),
      c(
        w([
          json({
            files: [
              {
                id: 's1',
                name: 'link',
                mimeType: SHORTCUT,
                shortcutDetails: { targetId: 't1', targetMimeType: DOCX },
              },
              { id: 's2', name: 'link2', mimeType: SHORTCUT, shortcutDetails: { targetId: 't1' } },
              { id: 's3', name: 'link3', mimeType: SHORTCUT, shortcutDetails: null },
              { id: 's4', name: 'link4', mimeType: SHORTCUT },
              { id: 's5', name: 'link5', mimeType: SHORTCUT, shortcutDetails: 'x' },
              {
                id: 's6',
                name: 'file',
                mimeType: 'text/plain',
                shortcutDetails: { targetId: 't1', targetMimeType: DOCX },
              },
            ],
          }),
        ]),
        { listing: { kind: 'recent' } },
      ),
      c(w([json({ files: [null] })]), { listing: { kind: 'recent' } }),
      ...[{}, 5, 'abc', true, 0, false, { map: 1 }, ''].map((files) =>
        c(w([json({ files })]), { listing: { kind: 'recent' } }),
      ),
      c(w([json(null)]), { listing: { kind: 'recent' } }),
      c(w([json('files')]), { listing: { kind: 'recent' } }),
      c(w([ok(['{broken'])]), { listing: { kind: 'recent' } }),
      c(w([ok(null)]), { listing: { kind: 'recent' } }),
      c(w([ok([], [], 401)]), { listing: { kind: 'recent' } }),
      c(w([r403('rateLimitExceeded')]), { listing: { kind: 'recent' } }),
      c(w([ABOUT]), { listing: { kind: 'recent' }, token: null }),
      c(w([{ hang: true }]), { listing: { kind: 'recent' } }),
    ],
  },
  'drive-api.DriveApi.file': {
    ts: api((a, o, signal) => a.file(o.id, signal)),
    cases: [
      c(w([json(FILE)]), { id: 'f1' }),
      c(w([json(FILE)]), { id: 'a b/c?d#e&f é가' }),
      c(w([json({ id: 'x', name: 'n', mimeType: 'm' })]), { id: 'x' }),
      c(w([json({ id: 'x', name: 'n' })]), { id: 'x' }),
      c(w([json({})]), { id: 'x' }),
      c(w([json([])]), { id: 'x' }),
      c(w([ok(['nope'])]), { id: 'x' }),
      c(w([ok(null)]), { id: 'x' }),
      c(w([json(null)]), { id: 'x' }),
      c(w([json(5)]), { id: 'x' }),
      c(w([ok([], [], 404)]), { id: 'gone' }),
      c(w([ok([], [], 401)]), { id: 'x' }),
      c(w([r403('other')]), { id: 'x' }),
      c(w([json(FILE)]), { id: 'x', token: null }),
      c(w([json(FILE)]), { id: 'x', noSignal: true }),
      c(w([{ hang: true }]), { id: 'x' }),
      c(w([{ hang: true }], { abortAt: 5000 }), { id: 'x' }),
    ],
  },
}

const SMALL = 'hello world'
const downloads = (name: 'download' | 'export'): Group[string] => ({
  ts: api((a, o, signal) =>
    name === 'download'
      ? a.download(o.id, o.maxBytes, signal)
      : a.export(o.id, o.mime, o.maxBytes, signal),
  ),
  cases: [
    c(w([ok([SMALL])]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok([SMALL])]), { id: 'f1', mime: DOCX, maxBytes: 100, download: true }),
    c(w([ok(['ab', { hex: 'cdef' }, 'g'])]), { id: 'a/b é', mime: 'text/plain', maxBytes: 100 }),
    c(w([ok(['ab', 'cd', 'ef'])]), { id: 'f1', mime: DOCX, maxBytes: 4 }),
    c(w([ok(['ab', 'cd'])]), { id: 'f1', mime: DOCX, maxBytes: 4 }),
    c(w([ok(['abc', 'de'])]), { id: 'f1', mime: DOCX, maxBytes: 4, download: true }),
    c(w([ok(['0123456789'], [['Content-Length', '10']])]), {
      id: 'f1',
      mime: DOCX,
      maxBytes: 10,
    }),
    c(w([ok(['0123456789'], [['Content-Length', '10']])]), {
      id: 'f1',
      mime: DOCX,
      maxBytes: 9,
    }),
    c(w([ok(['0123456789'], [['content-length', '999999999']])]), {
      id: 'f1',
      mime: DOCX,
      maxBytes: 100,
    }),
    c(w([ok(['0123456789'], [['Content-Length', 'abc']])]), {
      id: 'f1',
      mime: DOCX,
      maxBytes: 100,
    }),
    c(w([ok(['0123456789'], [['Content-Length', '']])]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok(['0123456789'], [['Content-Length', '5']])]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok(null)]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok(null)]), { id: 'f1', mime: DOCX, maxBytes: -1 }),
    c(w([ok([])]), { id: 'f1', mime: DOCX, maxBytes: 0 }),
    c(w([ok(['x'])]), { id: 'f1', mime: DOCX, maxBytes: 0 }),
    c(w([ok(['abc'])]), { id: 'f1', mime: DOCX, maxBytes: 3 }),
    c(w([ok(['abc', { error: 'stream cut' }])]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok([{ error: 'stream cut' }])]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok(['ab', 'cd'])]), { id: 'f1', mime: DOCX, maxBytes: Number.MAX_SAFE_INTEGER }),
    c(w([ok([{ hex: '00ff80' }])]), { id: 'f1', mime: DOCX, maxBytes: 3 }),
    c(w([ok([], [], 401)]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok([], [], 404)]), { id: 'f1', mime: DOCX, maxBytes: 100, download: true }),
    c(w([ok([], [], 429)]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([r403('exportSizeLimitExceeded')]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([r403('cannotDownloadFile')]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok(['oops'], [], 503)]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([ok(['file'], [['Location', 'https://cdn.example/x']], 302)]), {
      id: 'f1',
      mime: DOCX,
      maxBytes: 100,
      download: true,
    }),
    c(w([ok([SMALL])]), { id: 'f1', mime: DOCX, maxBytes: 100, token: null }),
    c(w([{ hang: true }]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
    c(w([{ hang: true }], { abortAt: 1000 }), {
      id: 'f1',
      mime: DOCX,
      maxBytes: 100,
      download: true,
    }),
    c(w([{ reject: { message: 'ECONNRESET' } }]), { id: 'f1', mime: DOCX, maxBytes: 100 }),
  ],
})

const transfers: Group = {
  'drive-api.DriveApi.download': downloads('download'),
  'drive-api.DriveApi.export': downloads('export'),
  'drive-api.DriveApi.upload': {
    ts: api((a, o, signal) =>
      a.upload(o.target, bytesOfHex(o.bytes), o.mime ?? 'application/octet-stream', signal),
    ),
    cases: [
      c(w(upload()), {
        target: { name: 'Report.docx', parentId: 'p1' },
        bytes: '0102',
        mime: DOCX,
      }),
      c(w(upload()), { target: { name: 'Report.docx' }, bytes: '', mime: 'text/plain' }),
      c(w(upload()), { target: { name: 'n', parentId: '' }, bytes: 'ff', mime: 'a/b' }),
      c(w(upload()), { target: { existingId: 'f1' }, bytes: '00ff', mime: 'application/pdf' }),
      c(w(upload()), { target: { existingId: 'a/b é' }, bytes: '00', mime: 'text/csv' }),
      c(w(upload()), { target: { name: 'q"uote\\n 가', parentId: 'p' }, bytes: '41', mime: 'x/y' }),
      c(w(upload()), { target: { name: 'n' }, bytes: '41', mime: ' text/plain \t' }),
      c(w(upload()), { target: { name: 'n' }, bytes: '41', mime: 'text/plain\nX: y' }),
      c(w(upload()), { target: { name: 'n' }, bytes: '41', mime: 'text/\u0100' }),
      c(w(upload()), { target: { name: 'n' }, bytes: '41', mime: 'a/b', token: null }),
      c(w(upload()), { target: { name: 'n' }, bytes: '41', mime: 'a/b', noSignal: true }),
      c(w([ok([], [])]), { target: { name: 'n' }, bytes: '41', mime: 'a/b' }),
      c(w([ok([], [['Location', '']])]), { target: { name: 'n' }, bytes: '41', mime: 'a/b' }),
      c(w([ok([], [['Location', 'https://evil.example/upload?id=1']])]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([ok([], [['Location', 'https://www.googleapis.com/upload/drive/v3']])]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([ok([], [['Location', `${UPLOAD}/`]]), json(FILE)]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([ok([], [], 401)]), { target: { name: 'n' }, bytes: '41', mime: 'a/b' }),
      c(w([r403('rateLimitExceeded')]), { target: { existingId: 'f1' }, bytes: '41', mime: 'a/b' }),
      c(w([ok([], [], 404)]), { target: { existingId: 'gone' }, bytes: '41', mime: 'a/b' }),
      c(w([ok(['x'], LOCATION, 200), ok(['oops'], [], 500)]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([ok([], LOCATION), ok([], [], 401)]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([ok([], LOCATION), json({ name: 'no id' })]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([ok([], LOCATION), ok(['not json'])]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([ok([], LOCATION), json(null)]), { target: { name: 'n' }, bytes: '41', mime: 'a/b' }),
      c(w([ok([], LOCATION), { hang: true }]), { target: { name: 'n' }, bytes: '41', mime: 'a/b' }),
      c(w([ok([], LOCATION), { hang: true }], { abortAt: 900 }), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
      c(w([{ hang: true }]), { target: { name: 'n' }, bytes: '41', mime: 'a/b' }),
      c(w([ok([], LOCATION), { reject: { message: 'reset' } }]), {
        target: { name: 'n' },
        bytes: '41',
        mime: 'a/b',
      }),
    ],
  },
}

// ---------------------------------------------------------------------------
// oauth.ts: the token calls and the sign-in
// ---------------------------------------------------------------------------

const clientOf = (o: A) => o.client ?? CLIENT

/** a fetch-and-answer of oauth.ts in the world */
function auth(call: (run: WorldRun, o: A, signal: AbortSignal | undefined) => Promise<unknown>) {
  return ([world, o]: unknown[], cx: TsContext) =>
    inWorld(world as World, cx, async (run, signal) => {
      const opts = (o ?? {}) as A
      return call(run, opts, opts.useSignal ? signal : undefined)
    })
}

const exchange = (o: Partial<A> = {}): A => ({
  code: 'code 1',
  verifier: 'ver+ifier',
  port: 40001,
  ...o,
})

const tokens: Group = {
  'oauth.pkcePair': {
    ts: auth(async (_run, o) => Array.from({ length: o.times ?? 1 }, () => oauth.pkcePair())),
    cases: [c(w([])), c(w([]), { times: 2 }), c(w([]), { times: 3 })],
  },
  'oauth.exchangeGoogleCode': {
    ts: auth((run, o, signal) =>
      oauth.exchangeGoogleCode(
        clientOf(o),
        o.code as string,
        o.verifier as string,
        o.port as number,
        run.fetch('node'),
        signal,
        clockOf(o.nowSeq),
      ),
    ),
    cases: [
      c(w([SIGNED_IN]), exchange()),
      c(w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })]), exchange()),
      c(
        w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: SCOPE })]),
        exchange(),
      ),
      c(
        w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'email' })]),
        exchange(),
      ),
      c(
        w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: '' })]),
        exchange(),
      ),
      c(
        w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 5 })]),
        exchange(),
      ),
      c(w([json({ access_token: 'a', refresh_token: 'r' })]), exchange()),
      c(w([json({ access_token: 'a', refresh_token: 'r', expires_in: 30 })]), exchange()),
      c(w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600.5 })]), exchange()),
      c(w([json({ access_token: 'a', refresh_token: 'r', expires_in: '3600' })]), exchange()),
      c(
        w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })]),
        exchange({ nowSeq: [5000] }),
      ),
      c(
        w([json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })]),
        exchange({ nowSeq: [1, 2] }),
      ),
      c(w([json({ access_token: 'a', expires_in: 3600 })]), exchange()),
      c(w([json({ access_token: 'a', refresh_token: '', expires_in: 3600 })]), exchange()),
      c(w([json({ access_token: 'a', refresh_token: 7, expires_in: 3600 })]), exchange()),
      c(w([json({ access_token: '', refresh_token: 'r', expires_in: 3600 })]), exchange()),
      c(w([json({ refresh_token: 'r', expires_in: 3600 })]), exchange()),
      c(w([json({})]), exchange()),
      c(w([json(null)]), exchange()),
      c(w([json([])]), exchange()),
      c(w([ok(['not json'])]), exchange()),
      c(w([ok(null)]), exchange()),
      c(w([json({ error: 'invalid_grant' }, 400)]), exchange()),
      c(w([ok([], [], 401)]), exchange()),
      c(w([ok(['oops'], [], 500)]), exchange()),
      c(w([ok([], [], 403)]), exchange()),
      c(w([{ reject: { message: 'offline' } }]), exchange()),
      c(w([]), exchange()),
      c(w([{ hang: true }]), exchange()),
      c(w([{ hang: true }]), exchange({ useSignal: true })),
      c(w([{ hang: true }], { abortAt: 100 }), exchange({ useSignal: true })),
      c(w([{ hang: true }], { abortAt: 100 }), exchange()),
      c(w([SIGNED_IN]), exchange({ code: 'a&b=c d', verifier: 'é가', port: 1 })),
      c(w([SIGNED_IN]), {
        client: { clientId: 'i d', clientSecret: 's&=' },
        code: '',
        verifier: '',
        port: 0,
      }),
      c(w([SIGNED_IN]), exchange({ useSignal: true })),
    ],
  },
  'oauth.refreshGoogleToken': {
    ts: auth((run, o, signal) =>
      oauth.refreshGoogleToken(
        clientOf(o),
        o.token as string,
        run.fetch('node'),
        signal,
        clockOf(o.nowSeq),
      ),
    ),
    cases: [
      c(w([TOKEN()]), { token: 'rt' }),
      c(w([TOKEN({ refresh_token: 'rotated', scope: 'x' })]), { token: 'rt' }),
      c(w([TOKEN()]), { token: 'rt', nowSeq: [10] }),
      c(w([TOKEN()]), { token: 'rt', nowSeq: [10, 20], useSignal: true }),
      c(w([json({ access_token: 'a', expires_in: 59 })]), { token: 'rt' }),
      c(w([json({ access_token: 'a', expires_in: 60 })]), { token: 'rt' }),
      c(w([json({ access_token: 'a', expires_in: 'x' })]), { token: 'rt' }),
      c(w([json({ access_token: 'a' })]), { token: 'rt' }),
      c(w([json({ access_token: '' })]), { token: 'rt' }),
      c(w([json({ access_token: 5 })]), { token: 'rt' }),
      c(w([json({})]), { token: 'rt' }),
      c(w([json(null)]), { token: 'rt' }),
      c(w([ok(['not json'])]), { token: 'rt' }),
      c(w([REVOKED]), { token: 'rt' }),
      c(w([json({ error: 'invalid_grant' }, 401)]), { token: 'rt' }),
      c(w([json({ error: 'invalid_client' }, 401)]), { token: 'rt' }),
      c(w([json({ error: 'invalid_request' }, 400)]), { token: 'rt' }),
      c(w([json({ error: ['invalid_grant'] }, 400)]), { token: 'rt' }),
      c(w([json({}, 400)]), { token: 'rt' }),
      c(w([json(null, 400)]), { token: 'rt' }),
      c(w([ok(['<html>', 'bad</html>'], [], 400)]), { token: 'rt' }),
      c(w([ok(null, [], 400)]), { token: 'rt' }),
      c(w([ok(['busy'], [], 503)]), { token: 'rt' }),
      c(w([json({ error: 'invalid_grant' }, 403)]), { token: 'rt' }),
      c(w([{ reject: { message: 'offline' } }]), { token: 'rt' }),
      c(w([]), { token: 'rt' }),
      c(w([{ hang: true }]), { token: 'rt' }),
      c(w([{ hang: true }], { abortAt: 50 }), { token: 'rt', useSignal: true }),
      c(w([TOKEN()]), { token: 'r t&+=/', client: { clientId: 'a b', clientSecret: 'é' } }),
    ],
  },
  'oauth.revokeGoogleToken': {
    ts: auth((run, o) => oauth.revokeGoogleToken(o.token as string, run.fetch('node'))),
    cases: [
      c(w([json({})]), { token: 'rt' }),
      c(w([ok([])]), { token: 'a b+c/=é' }),
      c(w([json({ error: 'invalid_token' }, 400)]), { token: 'rt' }),
      c(w([ok(['busy'], [], 503)]), { token: 'rt' }),
      c(w([ok([], [], 204)]), { token: 'rt' }),
      c(w([{ reject: { message: 'offline' } }]), { token: 'rt' }),
      c(w([]), { token: 'rt' }),
      c(w([{ hang: true }]), { token: 'rt' }),
      c(w([json({})]), { token: '' }),
    ],
  },
}

const signIn = (o: Partial<A> = {}): A => ({ pages: PAGES, ...o })

const signInWith = auth((run, o, signal) =>
  oauth.signInWithGoogle({
    client: clientOf(o),
    openBrowser: run.call('openBrowser') as Any,
    pages: (o.pages ?? PAGES) as Any,
    signal,
    fetch: o.noFetch ? undefined : run.fetch('node'),
    timeoutMs: o.timeoutMs,
    now: clockOf(o.nowSeq),
    pick: o.pick,
  }),
)

const signInCases = (pick?: { multiple: boolean }): Case[] => {
  const p = pick ? { pick } : {}
  return [
    c(w([SIGNED_IN], { calls: [true], requests: [back(0)] }), signIn(p)),
    c(w([SIGNED_IN], { calls: [true], requests: [back(0)] }), signIn({ ...p, nowSeq: [7] })),
    c(
      w([SIGNED_IN], {
        calls: [true],
        requests: [back(0, 'code=c1&picked_file_ids=f1,f2,f1,bad%20id,-x_')],
      }),
      signIn(p),
    ),
    c(
      w([SIGNED_IN], {
        calls: [true],
        requests: [back(0, `code=c1&scope=${encodeURIComponent(SCOPE)}`)],
      }),
      signIn(p),
    ),
    c(
      w([SIGNED_IN], {
        calls: [true],
        requests: [back(0, `code=c1&scope=${encodeURIComponent(`email ${SCOPE}`)}`)],
      }),
      signIn(p),
    ),
    c(w([], { calls: [true], requests: [back(0, 'code=c1&scope=email')] }), signIn(p)),
    c(w([], { calls: [true], requests: [back(0, 'error=access_denied')] }), signIn(p)),
    c(w([], { calls: [true], requests: [back(0, 'code=')] }), signIn(p)),
    c(w([], { calls: [true], requests: [back(0, 'code=&scope=email')] }), signIn(p)),
    c(
      w([SIGNED_IN], {
        calls: [true],
        requests: [
          { afterCall: 0, url: '/callback?code=x&state=wrong' },
          { afterCall: 0, url: '/callback?code=x' },
          { afterCall: 0, url: '/favicon.ico' },
          { afterCall: 0, url: '/other?code=x&state=$state' },
          { afterCall: 0, url: '/callback?code=x&state=$state', method: 'POST' },
          back(0),
          back(0, 'code=again'),
        ],
      }),
      signIn(p),
    ),
    c(
      w([], {
        calls: [true],
        requests: [{ afterCall: 0, url: '/callback?state=$state&code=c1', method: 'HEAD' }],
      }),
      signIn({ ...p, timeoutMs: 1000 }),
    ),
    c(w([], { calls: [false] }), signIn(p)),
    c(w([], { calls: [null] }), signIn(p)),
    c(w([], { calls: [{ reject: 'no browser' }] }), signIn(p)),
    c(w([], { calls: [true] }), signIn({ ...p, timeoutMs: 5000 })),
    c(w([], { calls: [true] }), signIn(p)),
    c(w([], { calls: [true] }), signIn({ ...p, useSignal: true })),
    c(w([], { calls: [true], abortAt: 100 }), signIn({ ...p, useSignal: true })),
    c(w([], { calls: [true], abortAt: 0 }), signIn({ ...p, useSignal: true })),
    c(w([], { calls: [true], abortAt: 100 }), signIn({ ...p, timeoutMs: 50, useSignal: true })),
    c(w([], { calls: [true], abortAt: 100 }), signIn(p)),
    c(w([]), signIn({ ...p, noFetch: true })),
    c(w([], { listenError: { message: 'listen EADDRINUSE', code: 'EADDRINUSE' } }), signIn(p)),
    c(w([ok([], [], 400)], { calls: [true], requests: [back(0)] }), signIn(p)),
    c(w([ok([], [], 500)], { calls: [true], requests: [back(0)] }), signIn(p)),
    c(w([], { calls: [true], requests: [back(0)] }), signIn(p)),
    c(w([{ reject: { message: 'offline' } }], { calls: [true], requests: [back(0)] }), signIn(p)),
    c(w([{ hang: true }], { calls: [true], requests: [back(0)] }), signIn(p)),
    c(
      w([{ hang: true }], { calls: [true], requests: [back(0)], abortAt: 300 }),
      signIn({ ...p, useSignal: true }),
    ),
    c(
      w([json({ access_token: 'a', expires_in: 1 })], { calls: [true], requests: [back(0)] }),
      signIn(p),
    ),
    c(
      w([SIGNED_IN], { calls: [true], requests: [back(0)] }),
      signIn({
        ...p,
        pages: { done: { lang: 'ko', title: '<완료>', body: '&' }, failed: PAGES.failed },
      }),
    ),
  ]
}

const signInGroup: Group = {
  'oauth.signInWithGoogle': {
    ts: signInWith,
    cases: [
      ...signInCases(),
      ...signInCases({ multiple: false }).slice(0, 8),
      ...signInCases({ multiple: true }).slice(0, 8),
    ],
  },
}

// ---------------------------------------------------------------------------
// DriveConnection
// ---------------------------------------------------------------------------

function connectionOf(run: WorldRun, o: A): Any {
  const vault = {
    load: run.call('vault.load') as Any,
    save: run.call('vault.save') as Any,
    clear: run.call('vault.clear') as Any,
  }
  return new connection.DriveConnection({
    client: o.client === undefined ? CLIENT : o.client,
    vault,
    fetch: run.fetch('node'),
    download: o.download ? run.fetch('net') : undefined,
    now: clockOf(o.nowSeq),
  })
}

// the tsconfig's lib has no Promise.withResolvers
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** the listeners of a scenario: one function per name, the handles `onChange` answered by label */
interface Listeners {
  fns: Map<string, (state: unknown) => void>
  handles: Map<string, () => boolean>
}

interface ListenerAction {
  remove?: string
  add?: string
  as?: string
}

/** `onChange` of the listener of that name: made on first use, with its actions */
function register(
  run: WorldRun,
  conn: Any,
  listeners: Listeners,
  name: string,
  handle: string,
  actions: ListenerAction[],
): void {
  let fn = listeners.fns.get(name)
  if (!fn) {
    fn = (state: unknown) => {
      run.log('state', name, state)
      for (const action of actions) {
        if (action.remove !== undefined) listeners.handles.get(action.remove)?.()
        else if (action.add !== undefined)
          register(run, conn, listeners, action.add, action.as ?? action.add, [])
      }
    }
    listeners.fns.set(name, fn)
  }
  listeners.handles.set(handle, conn.onChange(fn))
}

async function runStep(
  run: WorldRun,
  conn: Any,
  listeners: Listeners,
  o: A,
  signal: AbortSignal,
  step: Step,
): Promise<unknown> {
  const again = (steps: unknown) =>
    (steps as Step[]).map((s) => runStep(run, conn, listeners, o, signal, s))
  const pages = (o.pages ?? PAGES) as Any
  const options = { openBrowser: run.call('openBrowser') as Any, pages }
  switch (step.do) {
    case 'load':
      return conn.load()
    case 'state':
      return conn.state()
    case 'connected':
      return conn.connected()
    case 'connect':
      return conn.connect(options)
    case 'pick':
      return conn.pick(options, step.multiple === true)
    case 'cancelConnect':
      conn.cancelConnect()
      return null
    case 'disconnect':
      await conn.disconnect()
      return null
    case 'onChange':
      register(
        run,
        conn,
        listeners,
        step.name as string,
        (step.as as string | undefined) ?? (step.name as string),
        (step.actions as ListenerAction[] | undefined) ?? [],
      )
      return null
    case 'offChange':
      return listeners.handles.get((step.handle ?? step.name) as string)?.() ?? null
    case 'sleep':
      await sleep(step.ms as number)
      return null
    case 'settle':
      await sleep(0)
      return null
    case 'api.account':
      return shown(await conn.api.account(step.signal ? signal : undefined))
    case 'api.file':
      return shown(await conn.api.file(step.id, step.signal ? signal : undefined))
    case 'seq': {
      const out: unknown[] = []
      for (const s of step.steps as Step[])
        out.push(await runStep(run, conn, listeners, o, signal, s))
      return out
    }
    case 'parallel':
      return Promise.all(again(step.steps))
    default:
      throw new Error(`no such step: ${step.do}`)
  }
}

const scenario = ([world, o]: unknown[], cx: TsContext) =>
  inWorld(world as World, cx, async (run, signal) => {
    const opts = (o ?? {}) as A
    const conn = connectionOf(run, opts)
    const listeners: Listeners = { fns: new Map(), handles: new Map() }
    const out: unknown[] = []
    for (const step of opts.steps ?? []) {
      out.push((await runStep(run, conn, listeners, opts, signal, step)) ?? null)
    }
    return out
  })

const st = (name: string, extra: Record<string, unknown> = {}): Step => ({ do: name, ...extra })
const load = st('load')
const state = st('state')
const settle = st('settle')
const listen = (name: string) => st('onChange', { name })
const steps = (...list: Step[]): A => ({ steps: list })
const withSteps = (o: A, ...list: Step[]): A => ({ ...o, steps: list })
/** past the end of a 3540 s access token */
const expire = st('sleep', { ms: 4_000_000 })

const KEPT = { calls: ['rt'] }
const LOADED = (fetches: unknown[], more: Partial<World> = {}) => w(fetches, { ...KEPT, ...more })

const connectWorld = (more: Partial<World> = {}, fetches: unknown[] = [SIGNED_IN, ABOUT]) =>
  w(fetches, { calls: [true, true], requests: [back(0)], ...more })

const connectionCases = {
  state: [
    c(w([]), withSteps({ client: null }, state, st('connected'))),
    c(w([]), steps(state, st('connected'))),
    c(w([], { calls: [null] }), steps(load, state)),
    c(LOADED([TOKEN(), ABOUT]), steps(load, settle, state)),
    c(LOADED([REVOKED]), steps(load, settle, state)),
    c(LOADED([ok([], [], 503)]), steps(load, settle, state)),
    c(LOADED([TOKEN(), ABOUT]), steps(load, settle, st('disconnect'), state)),
  ],
  connected: [
    c(w([]), withSteps({ client: null }, st('connected'))),
    c(w([]), steps(st('connected'))),
    c(w([], { calls: [null] }), steps(load, st('connected'))),
    c(LOADED([TOKEN(), ABOUT]), steps(load, st('connected'))),
    c(LOADED([TOKEN(), ABOUT]), steps(load, settle, st('disconnect'), st('connected'))),
    c(LOADED([REVOKED]), steps(load, settle, st('connected'))),
  ],
  load: [
    ...[5, true, { a: 1 }, [1, [2, 3]], [], ' '].map((token) =>
      c(w([TOKEN(), ABOUT], { calls: [token] }), steps(load, settle, state)),
    ),
    ...[0, false].map((token) => c(w([], { calls: [token] }), steps(load, settle, state))),
    c(w([TOKEN(), ABOUT, json({})], { calls: [5] }), steps(load, settle, st('disconnect'), state)),
    c(
      w([TOKEN(), ABOUT, json({})], { calls: [{ a: 1 }] }),
      steps(load, settle, st('disconnect'), state),
    ),
    c(w([]), withSteps({ client: null }, load, load)),
    c(w([], { calls: [null] }), steps(listen('a'), load, load, state)),
    c(w([], { calls: [''] }), steps(load, state)),
    c(w([], { calls: [{ reject: 'vault locked' }] }), steps(load, state)),
    c(LOADED([TOKEN(), ABOUT]), steps(listen('a'), load, settle, state)),
    c(LOADED([TOKEN(), ABOUT]), steps(load, load, settle, state)),
    c(
      LOADED([TOKEN(), json({ user: { displayName: 'Lee' } })]),
      steps(listen('a'), load, settle, state),
    ),
    c(LOADED([TOKEN(), e403({ error: {} })]), steps(listen('a'), load, settle, state)),
    c(LOADED([TOKEN(), ok([], [], 401)]), steps(load, settle, state)),
    c(LOADED([TOKEN(), { hang: true }]), steps(load, settle, state)),
    c(
      LOADED([REVOKED], { calls: ['rt', undefined] }),
      steps(listen('a'), load, settle, state, st('api.file', { id: 'x' }), state),
    ),
    c(
      LOADED([json({ error: 'invalid_grant' }, 401)], {
        calls: ['rt', { reject: 'clear failed' }],
      }),
      steps(load, settle, state),
    ),
    c(
      LOADED([ok(['busy'], [], 503)]),
      steps(load, settle, state, st('api.file', { id: 'x' }), state, st('connected')),
    ),
    c(LOADED([{ reject: { message: 'offline' } }]), steps(load, settle, state)),
    c(LOADED([]), steps(load, settle, state)),
    c(
      LOADED([json({ error: 'invalid_grant' }, 400), json({})]),
      steps(load, st('api.account'), settle, state),
    ),
    c(LOADED([TOKEN(), ABOUT]), steps(load, settle, st('api.account'))),
  ],
  onChange: [
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(listen('a'), st('onChange', { name: 'a', as: 'a2' }), load, settle),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(
        listen('a'),
        st('onChange', { name: 'a', as: 'a2' }),
        st('offChange', { handle: 'a' }),
        st('offChange', { handle: 'a2' }),
        load,
        settle,
      ),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(
        listen('a'),
        st('onChange', { name: 'a', as: 'a2' }),
        st('offChange', { handle: 'a2' }),
        st('offChange', { handle: 'a' }),
        st('offChange', { handle: 'nobody' }),
        load,
        settle,
      ),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(
        listen('a'),
        st('offChange', { handle: 'a' }),
        st('onChange', { name: 'a', as: 'a3' }),
        st('offChange', { handle: 'a' }),
        st('offChange', { handle: 'a3' }),
        load,
        settle,
      ),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(st('onChange', { name: 'a', actions: [{ remove: 'b' }] }), listen('b'), load, settle),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(st('onChange', { name: 'a', actions: [{ add: 'c' }] }), load, settle),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(
        st('onChange', { name: 'a', actions: [{ remove: 'b' }, { add: 'b' }] }),
        listen('b'),
        listen('c'),
        load,
        settle,
      ),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(st('onChange', { name: 'a', actions: [{ remove: 'a' }] }), listen('b'), load, settle),
    ),
    c(LOADED([TOKEN(), ABOUT]), steps(listen('a'), listen('b'), load, settle)),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(listen('a'), listen('b'), st('offChange', { name: 'a' }), load, settle),
    ),
    c(
      LOADED([TOKEN(), ABOUT]),
      steps(listen('a'), load, settle, st('offChange', { name: 'a' }), st('disconnect')),
    ),
    c(LOADED([TOKEN(), ABOUT, ok([])]), steps(listen('a'), load, settle, st('disconnect'))),
    c(LOADED([REVOKED]), steps(listen('a'), load, settle)),
    c(w([]), withSteps({ client: null }, listen('a'), st('disconnect'))),
    c(w([]), steps(listen('a'), st('disconnect'), st('disconnect'))),
    c(
      w([]),
      steps(
        listen('a'),
        st('offChange', { name: 'a' }),
        st('offChange', { name: 'a' }),
        st('disconnect'),
      ),
    ),
    c(connectWorld(), steps(listen('a'), st('connect'), state)),
  ],
  connect: [
    ...[1, 'yes', {}, [], 0, ''].map((kept) =>
      c(connectWorld({ calls: [true, kept] }), steps(st('connect'), state)),
    ),
    c(connectWorld(), steps(listen('a'), st('connect'), state)),
    c(connectWorld({ calls: [true, false, undefined] }), steps(st('connect'), state)),
    c(
      connectWorld({ calls: [true, { reject: 'locked' }, undefined] }),
      steps(st('connect'), state),
    ),
    c(connectWorld({ calls: [true, undefined] }), steps(st('connect'), state)),
    c(
      connectWorld({ calls: [true, true] }, [SIGNED_IN, ok([], [], 403)]),
      steps(st('connect'), state),
    ),
    c(
      connectWorld({ calls: [true, true] }, [
        SIGNED_IN,
        json({ user: { displayName: 'Kim', emailAddress: 'k@e' } }),
      ]),
      steps(st('connect'), state, st('api.account')),
    ),
    c(connectWorld({ calls: [false] }), steps(st('connect'), state)),
    c(connectWorld({ calls: [{ reject: 'no browser' }] }), steps(st('connect'), state)),
    c(w([], { calls: [true] }), steps(st('connect'), state)),
    c(
      w([], { calls: [true], requests: [back(0, 'error=access_denied')] }),
      steps(st('connect'), state),
    ),
    c(
      w([], { calls: [true], requests: [back(0, 'code=c1&scope=email')] }),
      steps(st('connect'), state),
    ),
    c(
      w([json({ error: 'invalid_grant' }, 400)], { calls: [true], requests: [back(0)] }),
      steps(st('connect'), state),
    ),
    c(
      w([json({ access_token: 'a' })], { calls: [true], requests: [back(0)] }),
      steps(st('connect'), state),
    ),
    c(
      w([], { listenError: { message: 'EADDRINUSE', code: 'EADDRINUSE' } }),
      steps(st('connect'), state),
    ),
    c(w([]), withSteps({ client: null }, st('connect'))),
    c(
      connectWorld({ calls: ['rt', true, true], requests: [back(1)] }, [TOKEN(), ABOUT, SIGNED_IN]),
      steps(load, settle, state, st('connect'), state),
    ),
    c(
      LOADED([REVOKED, SIGNED_IN, ABOUT], {
        calls: ['rt', undefined, true, true],
        requests: [back(2)],
      }),
      steps(load, settle, state, st('connect'), state),
    ),
    c(
      connectWorld({ requests: [back(1)], calls: [true, true, true] }, [SIGNED_IN, ABOUT]),
      steps(
        st('parallel', { steps: [st('connect'), st('seq', { steps: [settle, st('connect')] })] }),
        state,
      ),
    ),
  ],
  pick: [
    c(
      connectWorld({ requests: [back(0, 'code=c1&picked_file_ids=f1')] }),
      steps(st('pick'), state),
    ),
    c(
      connectWorld({ requests: [back(0, 'code=c1&picked_file_ids=f1')] }),
      steps(st('pick', { multiple: true }), state),
    ),
    c(
      w(
        [
          json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 }),
          ABOUT,
          json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
        ],
        {
          calls: [true, true, true, true],
          requests: [
            back(0, 'code=c1&picked_file_ids=f1'),
            back(2, 'code=c2&picked_file_ids=f2,f3'),
          ],
        },
      ),
      steps(listen('a'), st('pick'), st('pick', { multiple: true }), state),
    ),
    c(w([], { calls: [true], requests: [back(0, 'x=1')] }), steps(st('pick'), state)),
    c(
      w([], { calls: [true], requests: [{ afterCall: 0, url: '/callback?state=$state' }] }),
      steps(st('pick'), state),
    ),
    c(
      w([], { calls: [true], requests: [back(0, 'code=c1&scope=email')] }),
      steps(st('pick', { multiple: true }), state),
    ),
    c(w([]), withSteps({ client: null }, st('pick'), st('pick', { multiple: true }))),
    c(w([], { calls: [false] }), steps(st('pick'), state)),
    c(w([], { calls: [true] }), steps(st('pick'), state)),
  ],
  cancelConnect: [
    c(w([]), steps(st('cancelConnect'), state)),
    c(w([]), withSteps({ client: null }, st('cancelConnect'), state)),
    c(
      w([], { calls: [true] }),
      steps(
        st('parallel', {
          steps: [st('connect'), st('seq', { steps: [settle, st('cancelConnect')] })],
        }),
        state,
      ),
    ),
    c(
      w([], { calls: [true] }),
      steps(
        st('parallel', {
          steps: [
            st('pick', { multiple: true }),
            st('seq', { steps: [settle, st('cancelConnect'), st('cancelConnect')] }),
          ],
        }),
        state,
      ),
    ),
    c(
      w([], { calls: [true] }),
      steps(st('parallel', { steps: [st('connect'), st('cancelConnect')] }), state),
    ),
    c(connectWorld(), steps(st('connect'), st('cancelConnect'), state)),
  ],
  disconnect: [
    c(LOADED([TOKEN(), ABOUT, json({})]), steps(load, settle, st('disconnect'), state)),
    c(
      LOADED([TOKEN(), ABOUT, ok(['busy'], [], 503)]),
      steps(load, settle, st('disconnect'), state),
    ),
    c(
      LOADED([TOKEN(), ABOUT, { reject: { message: 'offline' } }], {
        calls: ['rt', { reject: 'clear failed' }],
      }),
      steps(load, settle, st('disconnect'), state),
    ),
    c(LOADED([TOKEN(), ABOUT]), steps(load, settle, st('disconnect'), state)),
    c(w([]), steps(st('disconnect'), state)),
    c(w([]), withSteps({ client: null }, st('disconnect'), state)),
    c(LOADED([REVOKED]), steps(load, settle, st('disconnect'), state)),
    c(
      LOADED([TOKEN(), ABOUT, TOKEN(), json({})], { calls: ['rt', undefined] }),
      steps(
        load,
        settle,
        expire,
        st('parallel', { steps: [st('api.file', { id: 'f1' }), st('disconnect')] }),
        state,
      ),
    ),
    c(
      LOADED([TOKEN(), ABOUT, json({})]),
      steps(load, settle, st('disconnect'), st('api.file', { id: 'x' }), state),
    ),
  ],
  api: [
    c(w([]), steps(st('api.account'), st('api.file', { id: 'x' }))),
    c(w([]), withSteps({ client: null }, load, st('api.account'))),
    c(
      LOADED([TOKEN(), ABOUT, json(FILE), json(FILE)]),
      steps(load, settle, st('api.file', { id: 'f1' }), st('api.file', { id: 'f1', signal: true })),
    ),
    c(
      LOADED([TOKEN(), ABOUT, TOKEN({ access_token: 'at2' }), ABOUT, ABOUT]),
      steps(
        load,
        settle,
        expire,
        st('parallel', { steps: [st('api.account'), st('api.account')] }),
        state,
      ),
    ),
    c(
      LOADED([TOKEN(), ABOUT, TOKEN({ access_token: 'at2' }), ABOUT, ABOUT, ABOUT]),
      steps(
        load,
        settle,
        expire,
        st('parallel', { steps: [st('api.account'), st('api.account'), st('api.account')] }),
      ),
    ),
    c(
      LOADED([TOKEN(), ABOUT, ok(['busy'], [], 503), TOKEN({ access_token: 'at3' }), ABOUT]),
      steps(load, settle, expire, st('api.account'), st('api.account'), state),
    ),
    c(
      LOADED([TOKEN(), ABOUT, REVOKED], { calls: ['rt', undefined] }),
      steps(listen('a'), load, settle, expire, st('api.account'), st('api.account'), state),
    ),
    c(
      LOADED([TOKEN(), ABOUT, ABOUT, TOKEN(), ABOUT, ABOUT]),
      withSteps(
        { nowSeq: [1000, 2000, 5_000_000] },
        load,
        settle,
        st('api.account'),
        st('api.account'),
        st('api.account'),
      ),
    ),
  ],
}

const connectionGroup: Group = Object.fromEntries(
  Object.entries(connectionCases).map(([method, cases]) => [
    `connection.DriveConnection.${method}`,
    { ts: scenario, cases },
  ]),
)

export const group: Group = {
  ...pure,
  ...account,
  ...lists,
  ...transfers,
  ...tokens,
  ...signInGroup,
  ...connectionGroup,
}
