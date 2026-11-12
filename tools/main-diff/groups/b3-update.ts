/**
 * Group `b3-update`: update-resume.ts, update-notes.ts, update-restart.ts and
 * mac-update.ts of apps/shell/src/main.
 *
 * The Electron-facing pieces are driven through small fakes that both sides
 * build from the same JSON script and that log every call (the logger
 * convention): the download's `fetch`, the stock executor, the cancellation
 * token and the progress callback; the child processes of mac-update. The
 * module state of update-restart is reset by every case.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAC_SWAP_SCRIPT,
  installMacStaging,
  macAppBundle,
  macPreviousDir,
  macSelfUpdateBlock,
  macStagingDir,
  removeMacLeftovers,
  runProgram,
  stageMacUpdate,
  startMacSwap,
} from '../../../apps/shell/src/main/mac-update.ts'
import { normalizeReleaseNotes } from '../../../apps/shell/src/main/update-notes.ts'
import {
  cancelUpdateRestart,
  reopenedByInstaller,
  requestUpdateRestart,
  updateRestartRequested,
} from '../../../apps/shell/src/main/update-restart.ts'
import { installResumeDownload } from '../../../apps/shell/src/main/update-resume.ts'
import type { Case, Group, TsContext } from '../types.ts'

// ---------- update-restart.ts ----------

const applyOps = (ops: unknown): void => {
  cancelUpdateRestart()
  for (const op of ops as string[]) {
    if (op === 'request') requestUpdateRestart()
    else if (op === 'cancel') cancelUpdateRestart()
  }
}

const restartCases = (_note: string): Case[] => [
  { args: [[]], note: 'fresh state' },
  { args: [['request']], note: 'requested before' },
  { args: [['request', 'cancel']], note: 'requested then cancelled' },
  { args: [['cancel', 'request', 'request']], note: 'requested twice' },
]

// ---------- mac-update.ts ----------

const maskPid = (probe: string): string => probe.replace(/\d+$/, '#')

type Json = Record<string, unknown>

/** the `run` both sides fake: logs each call, answers from the script */
const fakeRun =
  (script: Json, cx: TsContext) =>
  async (file: string, args: string[]): Promise<string> => {
    cx.log('run', file, args)
    if (file === '/usr/bin/ditto') {
      if (typeof script.dittoError === 'string') throw new Error(script.dittoError)
      for (const name of (script.ditto as string[] | undefined) ?? []) {
        mkdirSync(join(args[3]!, name), { recursive: true })
      }
      return ''
    }
    if (file === '/usr/libexec/PlistBuddy') {
      const key = args[1]!.startsWith('Print :') ? args[1]!.slice('Print :'.length) : args[1]!
      const side = args[2]!.includes('.update') ? 'staged' : 'installed'
      const plist = script.plist as Record<string, Record<string, unknown>> | undefined
      const value = plist?.[side]?.[key]
      if (value === undefined) throw new Error('no key')
      if (typeof value === 'string') return value
      throw new Error(String((value as Json).error ?? ''))
    }
    if (file === '/usr/bin/codesign') {
      if (typeof script.codesignError === 'string') throw new Error(script.codesignError)
      return ''
    }
    throw new Error('unexpected program')
  }

const APP = '$DIR/Apps/Seu.app'
const EXEC = `${APP}/Contents/MacOS/Seu`
const goodScript = (extra: Json = {}): Json => ({
  ditto: ['Seu.app'],
  plist: {
    staged: { CFBundleShortVersionString: '1.2.0\n', CFBundleIdentifier: 'com.seu.office\n' },
    installed: { CFBundleIdentifier: 'com.seu.office' },
  },
  ...extra,
})
const installedBundle = { 'Apps/Seu.app/Contents/Info.plist': 'x' }

// ---------- update-resume.ts ----------

const sha = (text: string, enc: 'hex' | 'base64'): string =>
  createHash('sha512').update(text, 'utf8').digest(enc)

const DEST = '$DIR/cache/pending/app.exe'
const PART = 'cache/resume/app.exe.part'
const META = 'cache/resume/app.exe.part.json'
const PENDING = { 'cache/pending': { dir: true as const } }
const URL_ = 'https://example.test/dl/app.exe'
const FULL = 'hello world'
const HEX = sha(FULL, 'hex')
const B64 = sha(FULL, 'base64')

interface FetchScript {
  delayMs?: number
  fail?: string
  status: number
  etag?: string
  lastModified?: string
  contentLength?: string
  body?: Array<{ text?: string; hex?: string; delayMs?: number; error?: string }> | null
  endDelayMs?: number
}

const dl = (extra: Json, fetches: FetchScript[]): Json => ({
  url: URL_,
  destination: DEST,
  sha512: HEX,
  fetches,
  ...extra,
})
const ok200 = (extra: Partial<FetchScript> = {}): FetchScript => ({
  status: 200,
  contentLength: '11',
  body: [{ text: 'hello ' }, { text: 'world' }],
  ...extra,
})
const meta = (value: unknown): string => JSON.stringify(value)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** the global fetch, replaced by the script; every call is logged */
const scriptedFetch = (script: Json, cx: TsContext) => {
  let index = 0
  return async (
    url: unknown,
    init: { headers: unknown; signal?: AbortSignal },
  ): Promise<Response> => {
    const f = (script.fetches as FetchScript[] | undefined)?.[index++]
    cx.log('fetch', String(url), init.headers)
    if (f === undefined) throw new Error('no more scripted responses')
    await sleep(f.delayMs ?? 0)
    if (init.signal?.aborted) throw new Error('aborted')
    if (f.fail !== undefined) throw new TypeError(f.fail)
    let body: ReadableStream<Uint8Array> | null = null
    if (Array.isArray(f.body)) {
      const chunks = f.body
      let k = 0
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const item = chunks[k++]
          if (item === undefined) {
            await sleep(f.endDelayMs ?? 0)
            controller.close()
            return
          }
          await sleep(item.delayMs ?? 0)
          if (item.error !== undefined) {
            controller.error(new Error(item.error))
            return
          }
          controller.enqueue(
            item.hex !== undefined
              ? Buffer.from(item.hex, 'hex')
              : Buffer.from(item.text ?? '', 'utf8'),
          )
        },
      })
    }
    const headers: Record<string, string> = {}
    if (f.etag !== undefined) headers.etag = f.etag
    if (f.lastModified !== undefined) headers['last-modified'] = f.lastModified
    if (f.contentLength !== undefined) headers['content-length'] = f.contentLength
    return new Response(body, { status: f.status, headers })
  }
}

async function runResume(args: unknown[], cx: TsContext): Promise<unknown> {
  const script = args[0] as Json
  const shape = (script.shape as string | undefined) ?? 'ok'
  if (shape === 'noExecutor') {
    installResumeDownload({} as never)
    return { wrapped: false }
  }
  if (shape === 'notFunction') {
    const updater = { httpExecutor: { download: 5 } }
    installResumeDownload(updater as never)
    return { wrapped: (updater.httpExecutor.download as unknown) !== 5 }
  }
  const executor = {
    download: async (url: URL, destination: string, _options?: unknown): Promise<string> => {
      cx.log('stock', url.href, destination)
      if (typeof script.fallbackError === 'string') throw new Error(script.fallbackError)
      return `stock:${destination}`
    },
  }
  const cancelled = script.cancelled as boolean[] | undefined
  let checks = 0
  const token =
    cancelled === undefined
      ? undefined
      : {
          get cancelled(): boolean {
            const at = Math.min(checks++, Math.max(cancelled.length - 1, 0))
            return cancelled[at] ?? false
          },
        }
  const options = {
    sha512: script.sha512 as string | null,
    headers: script.headers as Record<string, string | null | undefined> | undefined,
    cancellationToken: token,
    onProgress: script.progress === true ? (info: unknown) => cx.log('progress', info) : undefined,
  }
  const stall = (script.stallMs as number | null | undefined) ?? undefined
  const response = (script.responseMs as number | null | undefined) ?? undefined
  installResumeDownload({ httpExecutor: executor }, stall, response)
  const realFetch = globalThis.fetch
  const realNow = Date.now
  let tick = 0
  const step = (script.clockStep as number | undefined) ?? 100
  globalThis.fetch = scriptedFetch(script, cx) as never
  Date.now = () => cx.now + step * tick++
  try {
    return await executor.download(
      new URL(script.url as string),
      script.destination as string,
      options as never,
    )
  } finally {
    globalThis.fetch = realFetch
    Date.now = realNow
  }
}

const resumeCases: Case[] = [
  { args: [dl({ sha512: null }, [])], files: PENDING, note: 'no checksum: stock executor' },
  { args: [dl({ sha512: '' }, [])], files: PENDING, note: 'empty checksum: stock executor' },
  { args: [{ shape: 'noExecutor' }], note: 'no executor: nothing wrapped' },
  { args: [{ shape: 'notFunction' }], note: 'download is not a function' },
  {
    args: [dl({}, [ok200()])],
    files: PENDING,
    note: 'fresh download, hex digest, no progress callback',
  },
  {
    args: [dl({ progress: true }, [ok200()])],
    files: PENDING,
    note: 'progress: first reported, second throttled, final forced',
  },
  {
    args: [dl({ progress: true, clockStep: 300 }, [ok200()])],
    files: PENDING,
    note: 'progress: every chunk reported at a slow clock',
  },
  {
    args: [
      dl({ progress: true, clockStep: 100 }, [
        ok200({
          contentLength: '5',
          body: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }],
        }),
      ]),
    ],
    files: PENDING,
    note: 'progress over many chunks, short body fails the checksum',
  },
  {
    args: [dl({ sha512: B64 }, [ok200()])],
    files: PENDING,
    note: 'base64 digest',
  },
  {
    args: [dl({ sha512: HEX.toUpperCase() }, [ok200()])],
    files: PENDING,
    note: 'upper-case hex differs from the digest: mismatch',
  },
  {
    args: [dl({}, [ok200({ body: [{ text: 'hello ' }, { text: 'WORLD' }] })])],
    files: PENDING,
    note: 'checksum mismatch discards part and meta',
  },
  {
    args: [dl({ progress: true }, [ok200({ contentLength: undefined })])],
    files: PENDING,
    note: 'no content-length: percent 0',
  },
  {
    args: [dl({ progress: true }, [ok200({ contentLength: 'abc' })])],
    files: PENDING,
    note: 'content-length not a number',
  },
  {
    args: [dl({ progress: true }, [ok200({ contentLength: '2.5' })])],
    files: PENDING,
    note: 'fractional content-length',
  },
  {
    args: [dl({ progress: true }, [ok200({ contentLength: '' })])],
    files: PENDING,
    note: 'empty content-length is 0',
  },
  {
    args: [dl({ progress: true }, [ok200({ contentLength: 'Infinity' })])],
    files: PENDING,
    note: 'infinite content-length is dropped',
  },
  {
    args: [dl({}, [{ status: 206, body: [{ text: 'hello world' }] }])],
    files: PENDING,
    note: '206 on a fresh download writes from the start',
  },
  {
    args: [
      dl({ progress: true }, [{ status: 206, contentLength: '5', body: [{ text: 'world' }] }]),
    ],
    files: {
      ...PENDING,
      [PART]: 'hello ',
      [META]: meta({ sha512: HEX, ifRange: '"v1"' }),
    },
    note: 'resume: Range and If-Range, 206 appends',
  },
  {
    args: [dl({}, [{ status: 206, contentLength: '5', body: [{ text: 'world' }] }])],
    files: { ...PENDING, [PART]: 'hello ', [META]: meta({ sha512: HEX }) },
    note: 'resume without a validator: no If-Range',
  },
  {
    args: [dl({}, [{ status: 206, contentLength: '5', body: [{ text: 'world' }] }])],
    files: { ...PENDING, [PART]: 'hello ', [META]: meta({ sha512: HEX, ifRange: '' }) },
    note: 'empty validator is no validator',
  },
  {
    args: [
      dl(
        {
          headers: {
            Authorization: 'Bearer x',
            Skip: null,
            Number: 5,
            '10': 'ten',
            '2': 'two',
            Range: 'bytes=0-1',
          },
        },
        [{ status: 206, contentLength: '5', body: [{ text: 'world' }] }],
      ),
    ],
    files: { ...PENDING, [PART]: 'hello ', [META]: meta({ sha512: HEX, ifRange: 'W/"e"' }) },
    note: 'caller headers: strings only, integer keys first, Range overwritten in place',
  },
  {
    args: [dl({ headers: { Accept: '*/*' } }, [ok200()])],
    files: PENDING,
    note: 'caller headers on a fresh request',
  },
  {
    args: [dl({}, [ok200()])],
    files: {
      ...PENDING,
      [PART]: 'old bytes that are longer',
      [META]: meta({ sha512: 'someone else', ifRange: '"v0"' }),
    },
    note: 'stale part of another artifact is dropped, no Range',
  },
  {
    args: [dl({}, [ok200()])],
    files: { ...PENDING, [PART]: 'hello ' },
    note: 'part without meta restarts',
  },
  {
    args: [dl({}, [ok200()])],
    files: { ...PENDING, [PART]: 'hello ', [META]: '[1,2]' },
    note: 'meta is an array: no digest, restart',
  },
  {
    args: [dl({}, [ok200()])],
    files: { ...PENDING, [PART]: 'hello ', [META]: '{"sha512":5}' },
    note: 'meta digest not a string: restart',
  },
  {
    args: [dl({}, [ok200()])],
    files: { ...PENDING, [PART]: 'hello ', [META]: '{not json' },
    note: 'meta not JSON: restart',
  },
  {
    args: [dl({}, [ok200()])],
    files: { ...PENDING, [PART]: 'hello ', [META]: '"text"' },
    note: 'meta is a string: restart',
  },
  {
    args: [dl({}, [{ status: 206, contentLength: '5', body: [{ text: 'world' }] }])],
    files: {
      ...PENDING,
      [PART]: 'hello ',
      [META]: meta({ sha512: HEX, ifRange: 5, extra: 1 }),
    },
    note: 'meta ifRange not a string is ignored',
  },
  {
    args: [dl({}, [ok200()])],
    files: { ...PENDING, [META]: meta({ sha512: HEX, ifRange: '"v1"' }) },
    note: 'meta without a part restarts',
  },
  {
    args: [dl({}, [{ status: 416 }, ok200()])],
    files: {
      ...PENDING,
      [PART]: 'hello world and more',
      [META]: meta({ sha512: HEX, ifRange: '"v1"' }),
    },
    note: '416 on a resume: wipe and download whole',
  },
  {
    args: [dl({}, [{ status: 416 }])],
    files: PENDING,
    note: '416 on a fresh request falls back',
  },
  {
    args: [dl({}, [{ status: 416 }, { status: 403 }])],
    files: { ...PENDING, [PART]: 'hello world and more', [META]: meta({ sha512: HEX }) },
    note: '416 then a refusal on the retry falls back',
  },
  {
    args: [dl({}, [{ status: 416 }, { fail: 'offline', status: 200 }])],
    files: { ...PENDING, [PART]: 'hello world and more', [META]: meta({ sha512: HEX }) },
    note: '416 then the retry cannot be placed',
  },
  {
    args: [dl({ cancelled: [false, true] }, [{ status: 416 }, ok200()])],
    files: { ...PENDING, [PART]: 'hello world and more', [META]: meta({ sha512: HEX }) },
    note: 'cancelled before the retry',
  },
  { args: [dl({}, [{ status: 403 }])], files: PENDING, note: '403 falls back' },
  { args: [dl({}, [{ status: 407 }])], files: PENDING, note: '407 falls back' },
  { args: [dl({}, [{ status: 500 }])], files: PENDING, note: '500 falls back' },
  {
    args: [dl({}, [{ status: 201, body: [{ text: 'hello world' }] }])],
    files: PENDING,
    note: '201 is ok',
  },
  {
    args: [dl({}, [{ fail: 'connection refused', status: 200 }])],
    files: PENDING,
    note: 'fetch rejects: stock executor',
  },
  {
    args: [dl({ fallbackError: 'stock failed' }, [{ fail: 'dns', status: 200 }])],
    files: PENDING,
    note: 'fetch rejects and the stock executor rejects too',
  },
  {
    args: [dl({ responseMs: 100 }, [ok200({ delayMs: 500 })])],
    files: PENDING,
    note: 'no response within the window: stock executor',
  },
  {
    args: [dl({ responseMs: 400 }, [ok200({ delayMs: 20 })])],
    files: PENDING,
    note: 'response inside a longer window',
  },
  {
    args: [dl({ cancelled: [true] }, [ok200()])],
    files: PENDING,
    note: 'cancelled before the request',
  },
  {
    args: [dl({ cancelled: [false, true] }, [ok200({ delayMs: 20 })])],
    files: PENDING,
    note: 'cancelled at the first chunk, nothing written',
  },
  {
    args: [dl({ cancelled: [true, false] }, [ok200()])],
    files: PENDING,
    note: 'cancelled once, then not: still aborted',
  },
  {
    args: [dl({ cancelled: [false, false, true] }, [ok200()])],
    files: PENDING,
    note: 'cancelled at the second chunk: the first stays in the part',
  },
  {
    args: [dl({ cancelled: [false, false, false, true] }, [ok200()])],
    files: PENDING,
    note: 'cancelled after the last chunk',
  },
  {
    args: [dl({ cancelled: [false] }, [ok200()])],
    files: PENDING,
    note: 'a token that never cancels',
  },
  {
    args: [
      dl({}, [
        ok200({
          etag: 'W/"abc"',
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          body: [{ text: 'hel' }, { error: 'boom', delayMs: 30 }],
        }),
      ]),
    ],
    files: PENDING,
    note: 'stream fails: part kept, etag is the validator',
  },
  {
    args: [
      dl({}, [
        ok200({
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          body: [{ text: 'hel' }, { error: 'boom', delayMs: 30 }],
        }),
      ]),
    ],
    files: PENDING,
    note: 'stream fails: last-modified is the validator',
  },
  {
    args: [
      dl({}, [
        ok200({
          etag: '',
          lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          body: [{ error: 'boom' }],
        }),
      ]),
    ],
    files: PENDING,
    note: 'empty etag wins over last-modified and is then no validator',
  },
  {
    args: [dl({}, [ok200({ body: [{ error: 'early failure' }] })])],
    files: PENDING,
    note: 'stream fails before any byte',
  },
  {
    args: [
      dl({ stallMs: 100 }, [ok200({ body: [{ text: 'hel' }, { text: 'lo ', delayMs: 500 }] })]),
    ],
    files: PENDING,
    note: 'stalled between chunks: aborted, part kept',
  },
  {
    args: [dl({ stallMs: 100 }, [ok200({ body: [{ text: 'hello world' }], endDelayMs: 500 })])],
    files: PENDING,
    note: 'stalled waiting for the end of the stream',
  },
  {
    args: [dl({ stallMs: 100 }, [ok200({ body: [{ text: 'hel', delayMs: 500 }] })])],
    files: PENDING,
    note: 'stalled before the first chunk',
  },
  {
    args: [
      dl({ stallMs: 100 }, [
        ok200({
          body: [
            { text: 'hello ', delayMs: 10 },
            { text: 'world', delayMs: 10 },
          ],
        }),
      ]),
    ],
    files: PENDING,
    note: 'slow but inside the stall window',
  },
  {
    args: [dl({}, [ok200({ body: null })])],
    files: PENDING,
    note: 'no body: aborted, empty part created',
  },
  {
    args: [dl({}, [{ status: 206, body: null }])],
    files: { ...PENDING, [PART]: 'hello ', [META]: meta({ sha512: HEX }) },
    note: 'no body while resuming keeps the part',
  },
  {
    args: [dl({}, [ok200({ body: [] })])],
    files: PENDING,
    note: 'empty body fails the checksum',
  },
  {
    args: [dl({ sha512: sha('', 'hex') }, [ok200({ body: [], contentLength: '0' })])],
    files: PENDING,
    note: 'empty artifact with its own digest',
  },
  {
    args: [
      dl({ sha512: sha('\u0131\u017F\u212A\u{1F600}', 'hex') }, [
        ok200({ body: [{ text: '\u0131\u017F' }, { text: '\u212A\u{1F600}' }] }),
      ]),
    ],
    files: PENDING,
    note: 'non-ASCII body',
  },
  {
    args: [
      dl({ sha512: sha('\u00FF\u0000', 'base64') }, [
        ok200({ body: [{ hex: 'c3bf' }, { hex: '00' }] }),
      ]),
    ],
    files: PENDING,
    note: 'binary chunks',
  },
  {
    args: [dl({}, [ok200()])],
    files: {
      ...PENDING,
      'cache/resume/other.exe.part': 'x',
      'cache/resume/other.exe.part.json': '{}',
      'cache/resume/keep-dir': { dir: true },
      'cache/resume/app.exe.part.json.bak': 'y',
    },
    note: 'parts of other artifacts are pruned, folders stay',
  },
  {
    args: [dl({}, [ok200()])],
    files: { ...PENDING, 'cache/resume': 'a file where the folder goes' },
    note: 'resume folder cannot be created',
  },
  {
    args: [dl({}, [ok200()])],
    files: {},
    note: 'pending folder missing: the rename fails',
  },
]

export const group: Group = {
  // ---------- update-restart.ts ----------
  'update-restart.requestUpdateRestart': {
    ts: (a) => {
      applyOps(a[0])
      const before = updateRestartRequested()
      requestUpdateRestart()
      return [before, updateRestartRequested()]
    },
    cases: restartCases('request'),
  },
  'update-restart.cancelUpdateRestart': {
    ts: (a) => {
      applyOps(a[0])
      const before = updateRestartRequested()
      cancelUpdateRestart()
      return [before, updateRestartRequested()]
    },
    cases: restartCases('cancel'),
  },
  'update-restart.updateRestartRequested': {
    ts: (a) => {
      applyOps(a[0])
      return updateRestartRequested()
    },
    cases: restartCases('query'),
  },
  'update-restart.reopenedByInstaller': {
    ts: (a) => reopenedByInstaller(a[0] as string[]),
    cases: [
      { args: [['seu', '--updated']], note: 'flag present' },
      { args: [['seu']], note: 'flag absent' },
      { args: [[]], note: 'empty argv' },
      { args: [['seu', '--updated=1', '--UPDATED', '-updated', 'updated']], note: 'near misses' },
      { args: [['--updated', '--updated']], note: 'twice' },
      { args: [['\u0131--updated', '\u{1F600}']], note: 'non-ASCII neighbours' },
    ],
  },

  // ---------- update-notes.ts ----------
  'update-notes.normalizeReleaseNotes': {
    ts: (a) => normalizeReleaseNotes(a[0]),
    cases: notesCases(),
  },

  // ---------- update-resume.ts ----------
  'update-resume.installResumeDownload': { ts: (a, cx) => runResume(a, cx), cases: resumeCases },

  // ---------- mac-update.ts ----------
  'mac-update.macAppBundle': {
    ts: (a) => macAppBundle(a[0] as string),
    cases: [
      { args: ['/Applications/Seu.app/Contents/MacOS/Seu'], note: 'a bundle' },
      { args: ['/usr/bin/node'], note: 'not a bundle' },
      { args: ['/A/Seu.app/Contents/Frameworks/Seu'], note: 'not in MacOS' },
      { args: ['/A/Seu.app/Resources/MacOS/Seu'], note: 'not in Contents' },
      { args: ['/A/Seu.dir/Contents/MacOS/Seu'], note: 'folder is not .app' },
      { args: ['/A/.app/Contents/MacOS/Seu'], note: 'a bundle named just .app' },
      { args: ['/A/Seu.App/Contents/MacOS/Seu'], note: '.app is case sensitive' },
      { args: ['Seu.app/Contents/MacOS/Seu'], note: 'relative path' },
      { args: ['/A/Seu.app/Contents/MacOS/'], note: 'trailing slash' },
      {
        args: ['/A B/Se\u00FC \u0131\u017F\u212A.app/Contents/MacOS/x'],
        note: 'spaces and non-ASCII',
      },
      { args: ['/A/\u{1F600}.app/Contents/MacOS/x'], note: 'astral name' },
      { args: [''], note: 'empty' },
      { args: ['/Contents/MacOS/x'], note: 'no bundle folder' },
    ],
  },
  'mac-update.macStagingDir': {
    ts: (a) => macStagingDir(a[0] as string),
    cases: [
      { args: ['/Applications/Seu.app'] },
      { args: ['/Seu.app'], note: 'at the root' },
      { args: ['Seu.app'], note: 'relative' },
      { args: ['/A B/\u0131\u017F\u212A \u{1F600}.app'], note: 'non-ASCII' },
      { args: ['/Applications//Seu.app/'], note: 'doubled and trailing slash' },
    ],
  },
  'mac-update.macPreviousDir': {
    ts: (a) => macPreviousDir(a[0] as string),
    cases: [
      { args: ['/Applications/Seu.app'] },
      { args: ['/Seu.app'], note: 'at the root' },
      { args: ['Seu.app'], note: 'relative' },
      { args: ['/A B/\u0131\u017F\u212A \u{1F600}.app'], note: 'non-ASCII' },
      { args: ['/Applications//Seu.app/'], note: 'doubled and trailing slash' },
    ],
  },
  'mac-update.macSelfUpdateBlock': {
    ts: (a, cx) =>
      macSelfUpdateBlock(
        a[0] as string,
        typeof a[1] === 'boolean'
          ? (dir, probe) => {
              cx.log('writable', dir, maskPid(probe))
              return a[1] as boolean
            }
          : undefined,
      ),
    cases: [
      { args: ['/usr/bin/node', true], note: 'not a bundle' },
      {
        args: ['/private/var/folders/x/AppTranslocation/ABC/d/Seu.app/Contents/MacOS/Seu', true],
        note: 'translocated',
      },
      { args: ['/Applications/Seu.app/Contents/MacOS/Seu', true], note: 'writable' },
      { args: ['/Applications/Seu.app/Contents/MacOS/Seu', false], note: 'read-only' },
      {
        args: ['/AppTranslocation/Seu.app/Contents/MacOS/Seu', false],
        note: 'translocated needs the slashes around the word',
      },
      { args: ['/AppTranslocationX/Seu.app/Contents/MacOS/Seu', true], note: 'near miss' },
      {
        args: [EXEC, null],
        files: { 'Apps/Seu.app': { dir: true } },
        note: 'real probe: writable',
      },
      {
        args: ['$DIR/NoSuchFolder/Seu.app/Contents/MacOS/Seu', null],
        note: 'real probe: folder missing',
      },
      {
        args: [EXEC, null],
        files: { 'Apps/Seu.app': { dir: true }, Apps: { dir: true, mode: 0o555 } },
        note: 'real probe: read-only folder',
      },
    ],
  },
  'mac-update.removeMacLeftovers': {
    ts: (a) => removeMacLeftovers(a[0] as string),
    cases: [
      {
        args: [APP],
        files: {
          'Apps/Seu.app/x': 'keep',
          'Apps/.Seu.app.update/Seu.app/Contents/x': 'staged',
          'Apps/.Seu.app.previous/y': 'previous',
        },
        note: 'both leftovers removed, the bundle stays',
      },
      { args: [APP], files: { 'Apps/Seu.app/x': 'keep' }, note: 'nothing to remove' },
      {
        args: [APP],
        files: { 'Apps/.Seu.app.update': 'a file', 'Apps/.Seu.app.previous': { dir: true } },
        note: 'a file and an empty folder',
      },
      {
        args: ['$DIR/Missing/Seu.app'],
        note: 'the folder is missing',
      },
      {
        args: [APP],
        files: {
          'Apps/.Seu.app.update/locked/x': 'x',
          'Apps/.Seu.app.update/locked': { dir: true, mode: 0o555 },
        },
        note: 'a read-only folder inside: never throws',
      },
    ],
  },
  'mac-update.runProgram': {
    ts: async (a) => {
      try {
        return await runProgram(a[0] as string, a[1] as string[])
      } catch (e) {
        throw new Error((e as Error).message, { cause: e })
      }
    },
    cases: [
      { args: ['/bin/echo', ['hi', 'there']], note: 'output' },
      { args: ['/bin/echo', []], note: 'no arguments' },
      { args: ['/bin/sh', ['-c', 'echo oops >&2; exit 3']], note: 'fails with a message' },
      { args: ['/usr/bin/false', []], note: 'fails silently' },
      { args: ['/nonexistent/program', ['a']], note: 'cannot start' },
      { args: ['/usr/bin/printf', ['\\303\\377x']], note: 'invalid UTF-8 output' },
      { args: ['/usr/bin/printf', ['\u0131\u017F\u212A\u{1F600}']], note: 'non-ASCII output' },
      {
        args: ['/bin/sh', ['-c', 'echo "  a  " >&2; exit 1']],
        note: 'stderr is trimmed in the detail',
      },
    ],
  },
  'mac-update.stageMacUpdate': {
    ts: (a, cx) =>
      stageMacUpdate({
        zip: a[0] as string,
        bundle: a[1] as string,
        version: a[2] as string,
        run: fakeRun(a[3] as Json, cx),
        step: (s) => cx.log('step', s),
      }),
    cases: [
      { args: ['$DIR/u.zip', APP, '1.2.0', goodScript()], files: installedBundle, note: 'staged' },
      {
        args: ['$DIR/u.zip', APP, '1.2.0', goodScript()],
        files: { ...installedBundle, 'Apps/.Seu.app.update/old/x': 'leftover' },
        note: 'a leftover staging folder is cleared first',
      },
      {
        args: ['$DIR/u.zip', APP, '1.2.0', goodScript()],
        files: { ...installedBundle, 'Apps/.Seu.app.update': 'a file' },
        note: 'the staging path is a file',
      },
      {
        args: ['$DIR/u.zip', '$DIR/Missing/Seu.app', '1.2.0', goodScript()],
        note: 'the staging folder cannot be made',
      },
      {
        args: ['$DIR/u.zip', APP, '1.2.0', goodScript({ ditto: [] })],
        files: installedBundle,
        note: 'no app in the zip',
      },
      {
        args: ['$DIR/u.zip', APP, '1.2.0', goodScript({ ditto: ['A.app', 'B.app'] })],
        files: installedBundle,
        note: 'two apps',
      },
      {
        args: [
          '$DIR/u.zip',
          APP,
          '1.2.0',
          goodScript({ ditto: ['Seu.app', 'readme.txt', 'x.App'] }),
        ],
        files: installedBundle,
        note: 'only names ending in .app count',
      },
      {
        args: ['$DIR/u.zip', APP, '1.3.0', goodScript()],
        files: installedBundle,
        note: 'wrong version',
      },
      {
        args: [
          '$DIR/u.zip',
          APP,
          '1.2.0',
          goodScript({
            plist: {
              staged: { CFBundleShortVersionString: '1.2.0', CFBundleIdentifier: 'com.other' },
              installed: { CFBundleIdentifier: 'com.seu.office' },
            },
          }),
        ],
        files: installedBundle,
        note: 'another bundle identifier',
      },
      {
        args: [
          '$DIR/u.zip',
          APP,
          '1.2.0',
          goodScript({ codesignError: 'a sealed resource is missing' }),
        ],
        files: installedBundle,
        note: 'signature check fails',
      },
      {
        args: ['$DIR/u.zip', APP, '1.2.0', goodScript({ dittoError: 'ditto: cannot read zip' })],
        files: installedBundle,
        note: 'unpacking fails',
      },
      {
        args: [
          '$DIR/u.zip',
          APP,
          '1.2.0',
          goodScript({ plist: { staged: {}, installed: { CFBundleIdentifier: 'x' } } }),
        ],
        files: installedBundle,
        note: 'the version key is missing',
      },
      {
        args: [
          '$DIR/u.zip',
          APP,
          '1.2.0',
          goodScript({
            plist: {
              staged: {
                CFBundleShortVersionString: '1.2.0',
                CFBundleIdentifier: { error: 'first' },
              },
              installed: { CFBundleIdentifier: { error: 'second' } },
            },
          }),
        ],
        files: installedBundle,
        note: 'both identifier reads fail: the first call wins',
      },
      {
        args: [
          '$DIR/u.zip',
          APP,
          '1.2.0',
          goodScript({
            plist: {
              staged: { CFBundleShortVersionString: '1.2.0', CFBundleIdentifier: 'a' },
              installed: { CFBundleIdentifier: { error: 'installed unreadable' } },
            },
          }),
        ],
        files: installedBundle,
        note: 'the installed identifier cannot be read',
      },
      {
        args: [
          '$DIR/u.zip',
          APP,
          '1.2.0',
          goodScript({
            plist: {
              staged: {
                CFBundleShortVersionString: '1.2.0',
                CFBundleIdentifier: { error: 'staged unreadable' },
              },
              installed: { CFBundleIdentifier: 'a' },
            },
          }),
        ],
        files: installedBundle,
        note: 'the staged identifier cannot be read',
      },
      {
        args: [
          '$DIR/\u0131\u017F\u212A.zip',
          '$DIR/Apps/Se\u00FC \u{1F600}.app',
          '\u{1F600}',
          {
            ditto: ['Se\u00FC.app'],
            plist: {
              staged: { CFBundleShortVersionString: '\u{1F600}\r\n', CFBundleIdentifier: ' id ' },
              installed: { CFBundleIdentifier: 'id\u00A0' },
            },
          },
        ],
        files: { 'Apps/Se\u00FC \u{1F600}.app/Contents/Info.plist': 'x' },
        note: 'non-ASCII names, values trimmed as JavaScript trims',
      },
    ],
  },
  'mac-update.installMacStaging': {
    ts: async (a, cx) => {
      const shape = a[0] as { updateDownloaded: string; dispatch: string }
      const updater: Record<string, unknown> = {}
      if (shape.updateDownloaded === 'fn') updater.updateDownloaded = async () => ['original']
      else if (shape.updateDownloaded === 'text') updater.updateDownloaded = 'text'
      if (shape.dispatch === 'fn') {
        updater.dispatchUpdateDownloaded = function (event: unknown) {
          cx.log('dispatch', event)
        }
      } else if (shape.dispatch === 'text') updater.dispatchUpdateDownloaded = 5
      const original = updater.updateDownloaded
      const installed = installMacStaging(updater, async (zip, version) => {
        cx.log('stage', zip, version)
        if (typeof a[2] === 'string') throw new Error(a[2])
      })
      if (!installed) return { installed, replaced: updater.updateDownloaded !== original }
      try {
        const result = await (
          updater.updateDownloaded as (i: unknown, e: unknown) => Promise<unknown>
        )(null, a[1])
        return { installed, result }
      } catch (e) {
        return { installed, error: (e as Error).message }
      }
    },
    cases: [
      {
        args: [
          { updateDownloaded: 'fn', dispatch: 'fn' },
          { downloadedFile: '/tmp/u.zip', version: '1.2.0' },
          null,
        ],
        note: 'installed, stage then dispatch',
      },
      {
        args: [
          { updateDownloaded: 'fn', dispatch: 'fn' },
          { downloadedFile: '/tmp/u.zip', version: '1.2.0' },
          'unzip failed',
        ],
        note: 'stage rejects: nothing dispatched',
      },
      {
        args: [
          { updateDownloaded: 'fn', dispatch: 'fn' },
          { downloadedFile: '\u0131\u{1F600}', version: '', extra: [1] },
          null,
        ],
        note: 'the whole event is dispatched',
      },
      {
        args: [{ updateDownloaded: 'fn', dispatch: 'fn' }, { version: '1.0' }, null],
        note: 'an event without a file: undefined is staged',
      },
      {
        args: [{ updateDownloaded: 'none', dispatch: 'fn' }, {}, null],
        note: 'no updateDownloaded',
      },
      { args: [{ updateDownloaded: 'fn', dispatch: 'none' }, {}, null], note: 'no dispatch' },
      {
        args: [{ updateDownloaded: 'text', dispatch: 'fn' }, {}, null],
        note: 'updateDownloaded not a function',
      },
      {
        args: [{ updateDownloaded: 'fn', dispatch: 'text' }, {}, null],
        note: 'dispatch not a function',
      },
    ],
  },
  'mac-update.MAC_SWAP_SCRIPT': {
    ts: () => MAC_SWAP_SCRIPT,
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'mac-update.startMacSwap': {
    ts: (a, cx) => {
      const o = a[0] as {
        pid: number
        bundle: string
        staged: string
        logFile: string
        opener?: string | null
      }
      const s = a[1] as {
        throws?: string
        pid?: number | null
        onThrows?: string
        unrefThrows?: string
      }
      return startMacSwap({
        pid: o.pid,
        bundle: o.bundle,
        staged: o.staged,
        logFile: o.logFile,
        opener: o.opener ?? undefined,
        spawnProgram: ((file: string, args: string[], options: unknown) => {
          cx.log('spawn', file, args, options)
          if (s.throws !== undefined) throw new Error(s.throws)
          return {
            pid: s.pid ?? undefined,
            on: () => {
              cx.log('on', 'error')
              if (s.onThrows !== undefined) throw new Error(s.onThrows)
            },
            unref: () => {
              cx.log('unref')
              if (s.unrefThrows !== undefined) throw new Error(s.unrefThrows)
            },
          }
        }) as never,
      })
    },
    cases: [
      {
        args: [
          {
            pid: 4242,
            bundle: '/Applications/Seu.app',
            staged: '/Applications/.Seu.app.update/Seu.app',
            logFile: '/d/update-log.txt',
          },
          { pid: 77 },
        ],
        note: 'started',
      },
      {
        args: [
          {
            pid: 4242,
            bundle: '/Applications/Seu.app',
            staged: '/s',
            logFile: '/l',
            opener: '/bin/echo',
          },
          { pid: 77 },
        ],
        note: 'another opener',
      },
      {
        args: [
          { pid: 4242, bundle: '/Applications/Seu.app', staged: '/s', logFile: '/l', opener: '' },
          { pid: 77 },
        ],
        note: 'an empty opener is kept',
      },
      {
        args: [{ pid: 1.5, bundle: 'Seu.app', staged: '/s', logFile: '/l' }, { pid: 1 }],
        note: 'fractional pid, relative bundle',
      },
      {
        args: [
          { pid: 1e21, bundle: '/A/\u0131\u017F\u212A.app', staged: '/s', logFile: '/l' },
          { pid: 1 },
        ],
        note: 'huge pid, non-ASCII bundle',
      },
      {
        args: [{ pid: -3, bundle: '/A/\u{1F600}.app', staged: '/s', logFile: '/l' }, { pid: 1 }],
        note: 'negative pid',
      },
      {
        args: [{ pid: 1, bundle: '/A/Seu.app', staged: '/s', logFile: '/l' }, {}],
        note: 'the child has no pid',
      },
      {
        args: [{ pid: 1, bundle: '/A/Seu.app', staged: '/s', logFile: '/l' }, { pid: null }],
        note: 'a null pid is none',
      },
      {
        args: [
          { pid: 1, bundle: '/A/Seu.app', staged: '/s', logFile: '/l' },
          { throws: 'spawn EACCES' },
        ],
        note: 'spawn throws',
      },
      {
        args: [
          { pid: 1, bundle: '/A/Seu.app', staged: '/s', logFile: '/l' },
          { pid: 5, onThrows: 'x' },
        ],
        note: 'on() throws',
      },
      {
        args: [
          { pid: 1, bundle: '/A/Seu.app', staged: '/s', logFile: '/l' },
          { pid: 5, unrefThrows: 'x' },
        ],
        note: 'unref() throws',
      },
    ],
  },
}

// ---------- update-notes.ts cases ----------

function notesCases(): Case[] {
  const html = (s: string): Case => ({ args: [s] })
  const big = (n: number, s = 'y'): string => s.repeat(n)
  const note = (version: unknown, text: unknown): unknown => ({ version, note: text })
  return [
    { args: [null], note: 'null' },
    { args: [42], note: 'a number' },
    { args: [{}], note: 'an object' },
    { args: [true], note: 'a boolean' },
    { args: [''], note: 'empty string' },
    { args: ['   \n '], note: 'white space only' },
    { args: ['No content.'], note: 'GitHub empty body' },
    { args: ['\u00A0No content.\uFEFF'], note: 'padding trimmed as JavaScript trims' },
    { args: ['no content.'], note: 'case matters' },
    { args: [[]], note: 'empty list' },
    html('<h1>Title</h1><p>Hello <strong>bold</strong> and <code>code</code></p>'),
    html('<h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>'),
    html('<h1></h1><h2> </h2><p></p><p> </p><ul></ul><ul><li></li></ul><pre>\n</pre>'),
    html('<h2>a <b>b <code>c</code></b> d</h2>'),
    html('<ul><li>one</li><li><strong>two</strong> <code>2</code></li><li></li></ul>'),
    html('<ol><li>a</li><li>b</li></ol>'),
    html(
      '<ul><li>a<ul><li>b</li><li><strong>c</strong> d</li></ul></li><li>e<ol><li><code>f</code></li></ol></li></ul>',
    ),
    html('<ul><li><strong>x<ul><li>y</li></ul></strong></li></ul>'),
    html('<p>a<br>b<br/>c<br></p>'),
    html('<p><br>start</p><p>end<br></p><p><br></p>'),
    html('<p>  lead and   inner \n whitespace   </p>'),
    html('<p>a <b>b</b> <b>c</b> <i>d</i> <b> e</b></p>'),
    html(
      '<p><b>a</b><b>b</b><code>c</code><code>d</code><b><code>e</code></b><code><b>f</b></code></p>',
    ),
    html('<p>a <em> b</em> <span> c </span></p>'),
    html('<p><a href="https://x">link</a> <del>gone</del> <custom-el>tag</custom-el></p>'),
    html('<pre>\n\n  code  \n  more\n\n</pre>'),
    html('<pre>a<br>b<code>c</code><b>d</b><script>x</script>e</pre>'),
    html('<pre>   \n</pre><pre>x   </pre><pre>\n\n</pre>'),
    html('<pre><img src=x>  tail \n</pre>'),
    html('<script>alert(1)</script><style>p{}</style><img src="x" alt="a"><p>kept</p>'),
    html('<p>a<img src=x>b<script>c</script>d<style>e</style></p>'),
    html('<ul><li>a<script>x</script></li></ul>'),
    html('<blockquote>quoted <b>text</b></blockquote>'),
    html('<div><p>in div</p><div><h3>nested</h3></div></div>'),
    html('<details><summary>sum</summary>body</details>'),
    html('<table><tr><td>cell</td><td><p>para</p></td></tr></table>'),
    html('<table>text<tr><td>cell</td></tr></table>'),
    html('stray text<p>para</p> more  text\n<!-- comment --><p>after</p>'),
    html('<!-- only a comment -->'),
    html('<!DOCTYPE html><p>doctype ignored</p>'),
    html('&amp; &lt;b&gt; &nbsp;x&nbsp; &#x1F600; &copy; &unknown; &#0; &#128512;'),
    html('<p>a\u00A0b\uFEFFc\u2028d\u3000e\u200Bf\u0085g</p>'),
    html('<p>\u0131\u017F\u212A \u{1F600} \u{10FFFF}</p>'),
    html('<ſtrong>not strong</ſtrong><p>\u212A<K>k</K></p>'),
    html(
      '<STRONG>upper</STRONG><P>Upper <B>B</B> <CODE>c</CODE></P><H2>H</H2><PRE>x\ny</PRE><UL><LI>i</LI></UL>',
    ),
    html('<p>unclosed <b>bold<p>next</p>'),
    html('</div>stray end</p><p>ok'),
    html('<ul><li>a<li>b</ul>'),
    html('<p><div>x</div></p>'),
    html('<p>a</p><template><p>hidden</p></template><p>shown</p>'),
    html('<noscript><p>x</p></noscript><p>y</p>'),
    html('<svg><foreignObject><p>x</p></foreignObject></svg><p>after svg</p>'),
    html('<math><mi>x</mi></math><p>after</p>'),
    html('<textarea><p>raw</p></textarea><p>t</p>'),
    html('<title>t</title><p>after title</p>'),
    html('<plaintext><p>all raw</p>'),
    html('<p id="a" class="b" onclick="x">attrs dropped</p>'),
    html('<body><p>body tag</p></body>'),
    html('<html><head><title>x</title></head><body><p>full doc</p></body></html>'),
    html('<h1>x</h1>\n<p>y</p>\n'),
    html('<p>a</p>\n\n<p>b</p>'),
    html('\u0000<p>nul</p>'),
    html('<p>' + '<b>'.repeat(30) + 'deep' + '</b>'.repeat(30) + '</p>'),
    html('<div>'.repeat(40) + '<p>deep div</p>' + '</div>'.repeat(40)),
    // list input
    {
      args: [
        [
          note('1.0', '<p>a</p>'),
          note('  2.0  ', '<p>b</p>'),
          note('   ', '<p>c</p>'),
          note(7, '<p>d</p>'),
          note(null, '<p>e</p>'),
        ],
      ],
      note: 'versions: trimmed, blank and non-string become null',
    },
    {
      args: [
        [
          note('1.0', 'No content.'),
          note('2.0', ''),
          note('3.0', 5),
          note('4.0', '<p>kept</p>'),
          null,
          5,
          'x',
          [1],
          { version: '5.0' },
          { note: '<p>no version</p>' },
        ],
      ],
      note: 'entries that are not usable are skipped',
    },
    {
      args: [
        [
          note('v'.repeat(70), '<p>long version</p>'),
          note('\u{1F600}'.repeat(40), '<p>astral versions</p>'),
        ],
      ],
      note: 'version cut at 64 UTF-16 units',
    },
    {
      args: [
        [note('1', '<img src=x>'), note('2', '<script>x</script>'), note('3', '<p>only this</p>')],
      ],
      note: 'sections without blocks are dropped',
    },
    {
      args: [[note('1', '<img src=x>'), note('2', '   <!-- c -->  ')]],
      note: 'no section has blocks',
    },
    {
      args: [Array.from({ length: 13 }, (_, i) => note(String(i), `<p>${i}</p>`))],
      note: 'thirteen sections: twelve kept, truncated',
    },
    {
      args: [Array.from({ length: 12 }, (_, i) => note(String(i), `<p>${i}</p>`))],
      note: 'twelve sections: not truncated',
    },
    {
      args: [
        Array.from({ length: 14 }, (_, i) =>
          note(String(i), i < 12 ? 'No content.' : '<p>late</p>'),
        ),
      ],
      note: 'empty entries do not count toward the cap',
    },
    // raw cap
    {
      args: [`<p>${big(262144 - 7)}</p>`],
      note: 'exactly at the raw limit: not cut, then capped by total',
    },
    {
      args: [`<p>${big(262144)}</p><p>second</p>`],
      note: 'beyond the raw limit: cut, truncated',
    },
    {
      args: [`<p>${'a '.repeat(200000)}</p>`],
      note: 'beyond the raw limit with spaces',
    },
    // total cap
    {
      args: [Array.from({ length: 100 }, () => `<p>${big(1000)}</p>`).join('')],
      note: 'many paragraphs: trailing blocks dropped',
    },
    {
      args: [Array.from({ length: 48 }, () => `<p>${big(1000)}</p>`).join('')],
      note: 'exactly at the total limit',
    },
    {
      args: [Array.from({ length: 49 }, () => `<p>${big(1000)}</p>`).join('')],
      note: 'one block over the total limit',
    },
    {
      args: [`<p>${big(60000)}</p>`],
      note: 'a single runaway paragraph keeps its head',
    },
    {
      args: [`<h2>${big(30000)}<b>${big(30000)}</b><code>${big(30000)}</code></h2>`],
      note: 'a single runaway heading with several runs',
    },
    {
      args: [`<ul>${Array.from({ length: 5 }, () => `<li>${big(20000)}</li>`).join('')}</ul>`],
      note: 'a single runaway list keeps whole items and a cut one',
    },
    {
      args: [`<ul><li>${big(30000)}</li><li>${big(30000)}</li></ul>`],
      note: 'a single list whose second item is cut away',
    },
    {
      args: [
        `<p>${big(30000)}</p><ul>${Array.from({ length: 3 }, () => `<li>${big(10000)}</li>`).join('')}</ul>`,
      ],
      note: 'trailing list loses items, then stops',
    },
    {
      args: [`<p>${big(30000)}</p><ul><li>${big(20000)}</li></ul>`],
      note: 'a one-item list is removed whole',
    },
    {
      args: [
        `<p>${big(30000)}</p><ul>${Array.from({ length: 4 }, () => `<li>${big(10000)}</li>`).join('')}</ul><p>tail</p>`,
      ],
      note: 'tail paragraph goes before list items',
    },
    {
      args: [
        [
          note('1', `<p>${big(30000)}</p>`),
          note('2', `<p>${big(30000)}</p>`),
          note('3', `<p>${big(5)}</p>`),
        ],
      ],
      note: 'later sections are emptied and removed',
    },
    {
      args: [[note('1', `<p>${big(50000)}</p>`), note('2', `<p>${big(1000)}</p>`)]],
      note: 'the last section goes, the first one fits',
    },
    {
      args: [[note('1', `<p>${big(30000)}</p>`), note('2', `<p>${big(30000)}</p>`)]],
      note: 'two sections: the last block goes, the rest stays',
    },
    {
      args: [`<p>${big(60000, '\u0131\u017F\u212A')}</p>`],
      note: 'runaway paragraph of BMP non-ASCII',
    },
    {
      args: [`<p>${'\u{1F600}'.repeat(30000)}</p>`],
      note: 'astral text counts UTF-16 units; cut on a pair boundary',
    },
    {
      args: [`<p>${big(47999)}</p><p>zz</p>`],
      note: 'second block pushes one unit over',
    },
  ]
}
