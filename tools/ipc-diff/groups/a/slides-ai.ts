/**
 * Group `a/slides-ai`: the slides AI channels: `apps/slides/src/main/ai-ipc.ts`
 * (the slides-only handlers and `ai:log-run-failure`),
 * `apps/slides/src/main/ai-proposal.ts` (the held proposal of an AI run) and the
 * `slides:ai-snapshot-restore` handler of `slides-main.ts`.
 *
 * Those modules import the whole slides main process (the pptx engine, the
 * subscription connections), so they are not loaded. Their statements that answer
 * these channels (and the session-state and ai-proposal functions the handlers
 * call) are taken from their sources with the TypeScript parser (each must be
 * found exactly once), stripped of types, and run over the names they use: the
 * fake Electron, the real libraries that are pure (`documentMediaRoots`,
 * `coverCropFractions`, `rasterImageExt`, `writeJsonAtomic`, `tMain`,
 * `withMediaCallSignal`) and stand-ins for what is not:
 *
 * - the pptx engine: a deck is a list of pages named by their text; `addPicture`
 *   and the other engine calls append a line to the page, which the Rust
 *   in-memory world (crates/shell-ipc/a/src/slides_ai/world.rs) writes the same
 * - the tools (`generateImageTool`, `analyzeMediaTool`, `aiToolCapabilities`),
 *   the download (`fetchRemoteImage`) and the subscription statuses: scripted by
 *   `hosts.a.slidesAi` (see crates/shell-ipc/a/src/probe/slides_ai.rs, which
 *   reads the same value); each call is one host log line named after it
 * - `scheduleHistoryNotify` and `scheduleDeckBroadcast`: nothing is sent (D1
 *   sends the notices; the Rust world only records that they were scheduled)
 * - `Date`: pinned at `hosts.a.slidesAi.now`, so the failure log's `ts` is the
 *   Rust side's pinned clock
 *
 * What the group does not run: a wait for writes in flight (no channel of this
 * batch starts a write, so `settleWrites` is always quiet), a window that goes
 * away during a call, and the abort of a media call (the fake views are never
 * destroyed).
 */
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { readSlidesAiFonts } from '../../../../apps/slides/src/main/ai-default-fonts.ts'
import { tMain } from '../../../../apps/slides/src/main/i18n-main.ts'
import { rasterImageExt } from '../../../../apps/slides/src/main/media-mime.ts'
import { normalizeAiSettings } from '../../../../packages/ai-provider/src/legacy-settings.ts'
import { documentMediaRoots } from '../../../../packages/ai-search/src/media-tools.ts'
import { withMediaCallSignal as realWithMediaCallSignal } from '../../../../packages/ai-search/src/media-call-abort.ts'
import { writeJsonAtomic } from '../../../../packages/electron-utils/src/atomic-write.ts'
import { MAX_REMOTE_IMAGE_BYTES } from '../../../../packages/electron-utils/src/remote-image.ts'
import { coverCropFractions } from '../../../../packages/pipelines/src/slides/cover-crop.ts'
import type { Call, Case, Group, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

/** the module's statements that answer the group's channels, `export` taken off */
const code = (entry: string, starts: readonly string[]): string =>
  entryStatements(entry, starts).replace(/^export /gm, '')

const ipcCode = code('apps/slides/src/main/ai-ipc.ts', [
  'const AI_SETTINGS_PATH =',
  'function slidesMediaRoots(',
  'function readJson<',
  'function readAiSettings(',
  'function screenToolContext(',
  'const AI_RUN_FAILURES_PATH =',
  'const RUN_FAILURE_TEXT_MAX',
  'const RUN_FAILURES_MAX_BYTES',
  'function appendRunFailure(',
  "ipcMain.handle('ai:log-run-failure',",
  'export function styleSkillSidecarPath(',
  "ipcMain.handle('slides:ai-default-fonts',",
  "ipcMain.handle('slides:ai-tool-capabilities',",
  "ipcMain.handle(\n    'ai:generate-image',",
  "ipcMain.handle(\n    'ai:analyze-media',",
  'const attachmentImageBytes =',
  "ipcMain.handle(\n    'ai:insert-image-url',",
  "ipcMain.handle(\n    'ai:replace-picture-url',",
  "ipcMain.handle(\n    'ai:save-sidecar',",
  'const STYLE_TEMPLATES_DIR =',
  'const savedStyleBasedOn =',
  "ipcMain.handle(\n    'ai:save-style-template',",
  "ipcMain.handle(\n    'ai:list-style-templates',",
  "ipcMain.handle(\n    'ai:load-style-template',",
])

const proposalCode = code('apps/slides/src/main/ai-proposal.ts', [
  'export function markerOf(',
  'function sameMarker(',
  'function sameStack(',
  'const WRITE_SETTLE_MS =',
  'export async function settleWrites(',
  'export function beginAiRun(',
  'export function holdAiRun(',
  'export function acceptAiProposal(',
  'const windowLives =',
  'export function rejectAiProposal(',
  'const sessionOf =',
  'const deckOf =',
  "ipcMain.handle('slides:ai-run-begin',",
  "ipcMain.handle('slides:ai-run-hold',",
  "ipcMain.handle(\n    'slides:ai-proposal-accept',",
  "ipcMain.handle('slides:ai-proposal-reject',",
])

const sessionStateCode = code('apps/slides/src/main/session-state.ts', [
  'const MAX_HISTORY =',
  'function trimHistory(',
  'export function takeSnapshot(',
  'function cloneSnapshot(',
  'export function pushHistory(',
  'const MAX_AI_SNAPSHOTS =',
  'let nextAiSnapshotId',
  'export function registerAiSnapshot(',
  'export function restoreAiSnapshot(',
  'export function restoreSnapshot(',
])

const snapshotRestoreCode = code('apps/slides/src/main/slides-main.ts', [
  "ipcMain.handle('slides:ai-snapshot-restore',",
])

const views: View[] = [
  { view: 1, window: 1, surface: 'Slides' },
  { view: 2, window: 2, surface: 'Slides' },
]
const slides = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
const other = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
const folder = { userData: { dir: true as const } }

/** a PNG header, 12 bytes: its first two bytes are the size nativeImage reports */
const PNG = '89504e470d0a1a0a00000000'
const PNG_BASE64 = 'iVBORw0KGgoAAAAA'
const HTML = '3c68746d6c3e6e6f70653c2f68746d6c3e'

const deck = { path: '$DIR/deck/a.pptx', pages: ['p1', 'p2'] }
const unsaved = { path: '', pages: ['p1', 'p2'] }

const frame = { xPx: 10, yPx: 20, wPx: 480, hPx: 270, fitWidthPx: 960 }

const cases: Case[] = [
  {
    note: 'generate_image and analyze_media: the request as the tool gets it, beside the open deck; what the tool threw',
    views,
    hosts: {
      a: {
        slidesAi: {
          sessions: { '1': deck },
          statuses: { codex: { state: 'ready' } },
          generateImage: [{ ok: { url: 'file:///made.png' } }, { throw: 'quota exceeded' }],
          analyzeMedia: [{ ok: 'a cat on a mat' }, { ok: { done: true } }],
        },
      },
    },
    calls: [
      slides('ai:generate-image', {
        prompt: 'a cat',
        model: 'm1',
        referenceImageUrls: ['a', 1],
        aspectRatio: '16:9',
        imageSize: '',
        transparentBackground: true,
      }),
      slides('ai:generate-image', { prompt: 'x', transparentBackground: 'yes' }),
      slides('ai:analyze-media', { mediaUrls: ['a.png', 2], requirements: null }),
      slides('ai:analyze-media', { mediaUrls: [] }),
    ],
  },
  {
    note: 'the media tools of a deck with no folder (unsaved) and of a view with no session',
    views,
    hosts: { a: { slidesAi: { sessions: { '1': unsaved } } } },
    calls: [
      slides('ai:generate-image', { prompt: 'unsaved' }),
      other('ai:analyze-media', { mediaUrls: ['x.png'], requirements: 'r' }),
    ],
  },
  {
    note: 'a media call with no usable payload throws before it reaches a tool',
    views,
    hosts: { a: { slidesAi: { sessions: { '1': deck } } } },
    calls: [
      slides('ai:generate-image'),
      slides('ai:analyze-media', { mediaUrls: 5 }),
      slides('ai:generate-image', { prompt: 'ok' }),
    ],
  },
  {
    note: 'style templates: saved under a safe name, listed in name order, loaded back; a blank basedOn is not stored',
    views,
    hosts: { a: { lang: 'en' } },
    files: {
      'userData/style-templates/empty.json': '{"topic":"t"}',
      'userData/style-templates/null.json': 'null',
      'userData/style-templates/notes.txt': 'x',
    },
    calls: [
      slides('ai:save-style-template', 'Q1/Review: *draft*', {
        topic: 'sales',
        styleSkill: 'bold',
        createdAt: '2026-01-01',
        layout: { chrome: 1 },
        basedOn: '  modern  ',
      }),
      slides('ai:save-style-template', 'plain', {
        topic: 't',
        styleSkill: 's',
        createdAt: 'c',
        basedOn: '   ',
      }),
      slides('ai:list-style-templates'),
      slides('ai:load-style-template', 'Q1/Review: *draft*'),
      slides('ai:load-style-template', 'plain'),
      slides('ai:load-style-template', 'ghost'),
      slides('ai:load-style-template', 'empty'),
    ],
  },
  {
    note: 'style template errors in Korean: an invalid name, a name that is not text, no data',
    views,
    hosts: { a: { lang: 'ko' } },
    files: folder,
    calls: [
      slides('ai:save-style-template', '', {}),
      slides('ai:save-style-template', 1, {}),
      slides('ai:save-style-template', 'named'),
      slides('ai:load-style-template', 'ghost'),
      slides('ai:load-style-template', 7),
      slides('ai:load-style-template'),
      slides('ai:list-style-templates'),
    ],
  },
  {
    note: 'a failed run is one clipped line of the post-mortem log; an entry that cannot be read is dropped',
    views,
    hosts: { a: { slidesAi: { now: 1700000000000 } } },
    files: folder,
    calls: [
      slides('ai:log-run-failure', {
        instruction: 'i'.repeat(20005),
        streamed: 'abc',
        reason: 'loop',
      }),
      slides('ai:log-run-failure', { instruction: 'second', streamed: '' }),
      slides('ai:log-run-failure'),
    ],
  },
  {
    note: 'the style sidecar is written beside a saved pptx; an unsaved deck, a deck that is not a pptx and a view without a session write nothing',
    views,
    files: { deck: { dir: true as const } },
    hosts: { a: { slidesAi: { sessions: { '1': deck } } } },
    calls: [
      slides('ai:save-sidecar', { topic: 't', styleSkill: 's', createdAt: 'c' }),
      other('ai:save-sidecar', { topic: 'u', styleSkill: 'v', createdAt: 'w' }),
    ],
  },
  {
    note: 'the sidecar of an unsaved deck and of an odp',
    views,
    hosts: {
      a: {
        slidesAi: { sessions: { '1': unsaved, '2': { path: '$DIR/deck/b.odp', pages: ['x'] } } },
      },
    },
    calls: [
      slides('ai:save-sidecar', { topic: 't' }),
      other('ai:save-sidecar', { topic: 't' }),
      slides('ai:save-sidecar'),
    ],
  },
  {
    note: 'the default AI fonts: the document language, then a stored choice',
    views,
    hosts: { a: { documentLocale: 'ja' } },
    files: folder,
    calls: [slides('slides:ai-default-fonts')],
  },
  {
    note: 'the default AI fonts in Korean, from a stored choice',
    views,
    hosts: { a: { documentLocale: 'ko' } },
    files: {
      'userData/app-settings.json': JSON.stringify({
        slidesAiFonts: { mode: 'serif', sans: 'Foo Sans', serif: 'Bar Serif' },
      }),
    },
    calls: [slides('slides:ai-default-fonts')],
  },
  {
    note: 'tool capabilities are asked with the stored settings and the screen context',
    views,
    hosts: {
      a: {
        slidesAi: {
          statuses: { codex: { state: 'ready' } },
          capabilities: { webSearch: { available: false } },
        },
      },
    },
    files: { 'userData/ai-settings.json': '{"provider":"openai","providers":{}}' },
    calls: [slides('slides:ai-tool-capabilities')],
  },
  {
    note: 'tool capabilities with no settings file',
    views,
    calls: [slides('slides:ai-tool-capabilities')],
  },
  {
    note: 'a run: begin, two AI pictures (a download and an attachment), a replacement, one that cannot be had, hold, accept, then roll back',
    views,
    hosts: {
      a: {
        slidesAi: {
          sessions: { '1': unsaved },
          images: { 'https://img.test/a.png': PNG, 'https://img.test/bad.png': HTML },
        },
      },
    },
    calls: [
      slides('slides:ai-run-begin'),
      slides('ai:insert-image-url', {
        slideIndex: 0,
        url: 'https://img.test/a.png',
        ...frame,
        aiRunExpected: true,
      }),
      slides('ai:insert-image-url', {
        slideIndex: 1,
        base64: PNG_BASE64,
        ext: 'PNG',
        ...frame,
        aiRunExpected: true,
      }),
      slides('ai:replace-picture-url', {
        slideIndex: 1,
        sourceId: 'd:7',
        url: 'https://img.test/a.png',
        aiRunExpected: true,
      }),
      slides('ai:replace-picture-url', {
        slideIndex: 0,
        sourceId: '8',
        url: 'https://img.test/a.png',
        keepSrcRect: true,
        aiRunExpected: true,
      }),
      slides('ai:insert-image-url', {
        slideIndex: 0,
        url: 'https://img.test/bad.png',
        ...frame,
        aiRunExpected: true,
      }),
      slides('ai:insert-image-url', {
        slideIndex: 0,
        url: 'https://img.test/missing.png',
        ...frame,
        aiRunExpected: true,
      }),
      slides('ai:insert-image-url', {
        slideIndex: 9,
        url: 'https://img.test/a.png',
        ...frame,
        aiRunExpected: true,
      }),
      slides('ai:replace-picture-url', {
        slideIndex: 0,
        sourceId: 'missing',
        url: 'https://img.test/a.png',
        aiRunExpected: true,
      }),
      slides('slides:ai-run-hold'),
      slides('slides:ai-run-hold'),
      slides('slides:ai-proposal-accept'),
      slides('slides:ai-proposal-accept'),
      slides('slides:ai-snapshot-restore', 1),
      slides('slides:ai-snapshot-restore', 1),
      slides('slides:ai-snapshot-restore', '1'),
    ],
  },
  {
    note: 'a rejected proposal; a picture the run expected with none open; an ordinary insert outside a run',
    views,
    hosts: {
      a: {
        slidesAi: {
          sessions: { '1': unsaved },
          images: { 'https://img.test/a.png': PNG },
        },
      },
    },
    calls: [
      slides('ai:insert-image-url', {
        slideIndex: 0,
        url: 'https://img.test/a.png',
        ...frame,
        aiRunExpected: true,
      }),
      slides('ai:insert-image-url', { slideIndex: 0, url: 'https://img.test/a.png', ...frame }),
      slides('slides:ai-run-begin'),
      slides('ai:insert-image-url', {
        slideIndex: 1,
        url: 'https://img.test/a.png',
        ...frame,
        aiRunExpected: true,
      }),
      slides('slides:ai-run-begin'),
      slides('slides:ai-run-hold'),
      slides('slides:ai-proposal-reject'),
      slides('slides:ai-proposal-reject'),
      slides('slides:ai-proposal-accept'),
    ],
  },
  {
    note: 'master view refuses a run and a rollback; a picture handler with no payload throws',
    views,
    hosts: { a: { slidesAi: { sessions: { '1': { ...unsaved, masterEdit: true } } } } },
    calls: [
      slides('slides:ai-run-begin'),
      slides('slides:ai-snapshot-restore', 1),
      slides('ai:insert-image-url'),
      slides('ai:replace-picture-url'),
    ],
  },
  {
    note: 'a view with no session gets the empty answers',
    views,
    hosts: { a: { slidesAi: { sessions: { '1': unsaved } } } },
    calls: [
      other('slides:ai-run-begin'),
      other('slides:ai-run-hold'),
      other('slides:ai-proposal-accept'),
      other('slides:ai-proposal-reject'),
      other('slides:ai-snapshot-restore', 1),
      other('ai:insert-image-url', { slideIndex: 0, url: 'https://img.test/a.png', ...frame }),
      other('ai:replace-picture-url', {
        slideIndex: 0,
        sourceId: '7',
        url: 'https://img.test/a.png',
      }),
    ],
  },
]

/** `new Date()` pinned at `now`, as the Rust side's clock is */
function pinnedDate(now: number): DateConstructor {
  return class extends Date {
    constructor(...args: unknown[]) {
      super(...((args.length ? args : [now]) as [number]))
    }
    static now(): number {
      return now
    }
  } as DateConstructor
}

interface SlidesAiHosts {
  lang?: string
  documentLocale?: string
  slidesAi?: {
    sessions?: Record<string, { path: string; pages: string[]; masterEdit?: boolean }>
    statuses?: unknown
    capabilities?: unknown
    generateImage?: { ok?: unknown; throw?: string }[]
    analyzeMedia?: { ok?: unknown; throw?: string }[]
    images?: Record<string, string | null>
    now?: number
  }
}

export const group: Group = {
  batch: 'A',
  async load(cx) {
    const hostsA = (cx.case.hosts?.a ?? {}) as SlidesAiHosts
    const scripted = hostsA.slidesAi ?? {}
    const log = cx.electron.log
    const lang = hostsA.lang ?? 'ko'

    const sessions = new Map<number, Record<string, unknown>>()
    for (const [view, spec] of Object.entries(scripted.sessions ?? {})) {
      sessions.set(Number(view), {
        path: spec.path,
        fitWidthPx: 960,
        undoStack: [],
        redoStack: [],
        metaDirty: false,
        masterEdit: spec.masterEdit ? {} : undefined,
        opened: {
          deck: {
            slides: spec.pages.map((path) => ({
              path,
              // the pictures a page has, for a replacement to find
              elements: ['7', '8'].map((id) => ({
                id,
                type: 'picture',
                transform: { offset: { cx: 100, cy: 100 } },
              })),
            })),
            size: { cx: 9525 * 960 },
          },
          archive: { entries: new Map() },
        },
      })
    }

    const answers = (key: 'generateImage' | 'analyzeMedia') => {
      let at = 0
      return () => {
        const answer = scripted[key]?.[at++] ?? { ok: { done: true } }
        if (answer.throw !== undefined) throw new Error(answer.throw)
        return answer.ok
      }
    }
    const nextGenerated = answers('generateImage')
    const nextAnalyzed = answers('analyzeMedia')
    const statuses = scripted.statuses ?? {}
    type Bytes = Uint8Array

    const tool =
      (name: string, next: () => unknown) =>
      (path: string, request: unknown, opts: { mediaRoots: string[]; context: unknown }) => {
        log.push([name, path, request, { mediaRoots: opts.mediaRoots, context: opts.context }])
        return next()
      }

    const names: Record<string, unknown> = {
      ipcMain: cx.electron.ipcMain,
      app: cx.electron.app,
      Date: pinnedDate(scripted.now ?? 1_700_000_000_000),
      join,
      appendFileSync,
      existsSync,
      readdirSync,
      readFileSync,
      renameSync,
      statSync,
      writeFileSync,
      sessions,
      EMU_PER_PX_96: 9525,
      MAX_REMOTE_IMAGE_BYTES,
      writeJsonAtomic,
      readSlidesAiFonts,
      rasterImageExt,
      coverCropFractions,
      documentMediaRoots,
      documentLocale: () => hostsA.documentLocale ?? 'ko',
      tm: (key: string, params?: Record<string, string>) =>
        (tMain as (lang: string, key: string, params?: unknown) => string)(lang, key, params),
      storedAiSettings: (stored: unknown) => normalizeAiSettings(stored),
      sharedSubscriptionStatuses: () => statuses,
      aiToolCapabilities: (settings: unknown, context: unknown) => {
        log.push(['aiToolCapabilities', settings, context])
        return scripted.capabilities ?? { webSearch: { available: true } }
      },
      generateImageTool: tool('generateImageTool', nextGenerated),
      analyzeMediaTool: tool('analyzeMediaTool', nextAnalyzed),
      // the fake web contents has no removeListener: the real wrapper gets a sender that has one
      withMediaCallSignal: (
        sender: { id: number; isDestroyed(): boolean },
        run: (signal: AbortSignal) => unknown,
      ) =>
        realWithMediaCallSignal(
          {
            id: sender.id,
            isDestroyed: () => sender.isDestroyed(),
            once: () => undefined,
            removeListener: () => undefined,
          },
          run,
        ),
      fetchRemoteImage: async (url: string) => {
        log.push(['fetchRemoteImage', url])
        const hex = scripted.images?.[url]
        return typeof hex === 'string' ? { ok: true, hex } : null
      },
      readBodyCapped: async (resp: { hex: string }): Promise<Bytes> =>
        Uint8Array.from(Buffer.from(resp.hex, 'hex')),
      nativeImage: {
        createFromBuffer: (buf: Buffer) => ({
          isEmpty: () => buf.length === 0,
          toPNG: () => buf,
          getSize: () => ({ width: buf[0], height: buf[1] }),
        }),
      },
      // the pptx engine: a picture is a line appended to its page
      addPicture: (
        _opened: unknown,
        slide: { path: string },
        op: { bytes: Bytes; ext: string; offset: { x: number; y: number; cx: number; cy: number } },
      ) => {
        const o = op.offset
        slide.path += `+picture(${op.bytes.length} bytes,${op.ext},${o.x},${o.y},${o.cx},${o.cy})`
        return { id: `pic-${slide.path.length}` }
      },
      editPictureSrcRect: (
        slide: { path: string },
        _id: string,
        crop: { l: number; t: number; r: number; b: number },
      ) => {
        slide.path += `+crop(${crop.l},${crop.t},${crop.r},${crop.b})`
      },
      replacePictureBytes: (
        _opened: unknown,
        slide: { path: string },
        id: string,
        bytes: Bytes,
        ext: string,
        options?: { keepSrcRect?: boolean },
      ) => {
        if (id === 'missing') return false
        slide.path += `+replace(${id},${bytes.length} bytes,${ext},keep=${options?.keepSrcRect === true})`
        return true
      },
      matchesElementRef: (el: { id: string }, ref: string) => ref === `d:${el.id}`,
      rebuildSlide: (session: { opened: { deck: { slides: { path: string }[] } } }, i: number) => {
        const slide = session.opened.deck.slides[i]
        return slide ? { page: slide.path } : null
      },
      buildAllRenderSlides: (opened: { deck: { slides: { path: string }[] } }) =>
        opened.deck.slides.map((slide) => slide.path),
      scheduleHistoryNotify: () => undefined,
      scheduleDeckBroadcast: () => undefined,
    }
    runWith(`${ipcCode}\n${proposalCode}\n${sessionStateCode}\n${snapshotRestoreCode}`, names)
  },
  cases,
  single: {
    'ai:log-run-failure':
      'always answers undefined; what differs is the line written to the log (the folder)',
  },
}
