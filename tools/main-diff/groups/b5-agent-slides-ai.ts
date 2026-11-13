/**
 * Group `b5-agent-slides-ai`: `apps/slides/src/main/ai-ipc.ts` and
 * `ai-proposal.ts`, with the pieces of `packages/*` they needed that no module
 * ported before: `withStoredUnknownFields`, `withStoredSubscriptionOff`,
 * `withStoredKeyModels`, `withStoredMainFields`, `coverCropFractions`, and the
 * two pure functions of `ai-stream.ts`.
 *
 * Both modules are loaded as a patched copy per case (see `loadWorld`): the
 * libraries behind them (the search and media tools, `runAiStream`, the
 * subscription connections, the pptx engine, `nativeImage`, the download) are
 * stubs the case drives, each call of a stub is one log line, as the Rust
 * fakes of calls/b5_agent/slides_ai.rs write it. The real pieces stay real:
 * the session state (with a stub pptx engine), the settings guard, the secret
 * sealing, `abortOnDestroyed`, the media calls, the run guard and
 * `documentMediaRoots`. The clock of the proposal module is virtual (`Date.now`,
 * `setTimeout`), so a wait for writes is exact. A timer of `setImmediate` in
 * the session state is never run: the flags `notify` and `broadcast` of the
 * state say what was queued.
 *
 * A case is one world (`world()`): the session, the senders, the host and a list
 * of steps. A step answers with a result; the answer is `{ steps, state, files }`.
 * The functions of the two modules name the world a case runs in:
 *
 * - `registerAiProposalIpc`, `beginAiRun`, `holdAiRun`, `acceptAiProposal`,
 *   `rejectAiProposal`, `dropAiRunOf`, `markerOf`, `assertNoAiRun`,
 *   `trackWrite`, `settleWrites`: the steps `begin`, `hold`, `accept`, `reject`,
 *   `drop`, `marker`, `assert`, `track`, `settle` and the `invoke` of the
 *   `slides:ai-*` channels.
 * - `registerAiIpc` and `registerSlidesOnlyAiIpc`: `setup`, `subDep` and the
 *   `invoke` of the `ai:*` channels.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setAiRunGuard } from '@seuoffice/electron-utils/ai-run-guard'
import { useElectron } from '../electron-fake.ts'
import { coverCropFractions } from '../../../packages/pipelines/src/slides/cover-crop.ts'
import {
  withStoredSubscriptionOff,
  withStoredUnknownFields,
} from '../../../packages/ai-provider/src/providers.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const g = globalThis as J
const repo = new URL('../../../', import.meta.url)
const scratch = new URL('../out/b5-agent-slides-ai/', import.meta.url)
let scratchCount = 0
let scratchReady = false

function scratchFile(name: string, source: string): string {
  if (!scratchReady) {
    mkdirSync(fileURLToPath(scratch), { recursive: true })
    process.on('exit', () => rmSync(fileURLToPath(scratch), { recursive: true, force: true }))
    scratchReady = true
  }
  scratchCount += 1
  const path = fileURLToPath(new URL(`${scratchCount}-${name}`, scratch))
  writeFileSync(path, source)
  return pathToFileURL(path).href
}

/** `from` replaced by `to` where the source has it, or an error naming the file */
function must(src: string, from: string, to: string, file: string): string {
  if (!src.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)} to patch`)
  return src.split(from).join(to)
}

const repoUrl = (file: string): string => pathToFileURL(fileURLToPath(new URL(file, repo))).href

/** The address of a copy of `file` (from the repository root): `patch` first, then every relative import made absolute. */
function patchedUrl(file: string, patch: (src: string) => string): string {
  const original = new URL(file, repo)
  const dir = dirname(fileURLToPath(original))
  const src = patch(readFileSync(original, 'utf8')).replace(
    /(from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g,
    (_m: string, pre: string, spec: string) => {
      const target = resolvePath(dir, spec)
      const withExt = /\.(ts|mts|js|json)$/.test(target) ? target : `${target}.ts`
      return `${pre}'${pathToFileURL(withExt).href}'`
    },
  )
  return scratchFile(basename(file).replace(/\.ts$/, '.mts'), src)
}

// ---------------------------------------------------------------------------
// the world of a case
// ---------------------------------------------------------------------------

const MAIN = 'apps/slides/src/main/'

/** Names the modules import that the case drives (`lib()` of the stub below). */
const LIB_SOURCE = (urls: Record<string, string>): string => `
const G = () => globalThis.__b5SlidesAi
export { sanitizeAiSettings, withStoredUnknownFields, sealAiSecrets } from '@seuoffice/ai-provider'
export { withStoredMainFields } from '@seuoffice/ai-provider/key-models'
export { abortOnDestroyed, MAX_REMOTE_IMAGE_BYTES, safeExternalUrl, writeJsonAtomic } from '@seuoffice/electron-utils'
export { aiRunRefusal } from '@seuoffice/electron-utils/ai-run-guard'
export { abortMediaCalls, withMediaCallSignal } from '${urls.mediaCallAbort}'
export { documentMediaRoots } from '${urls.mediaTools}'
export { coverCropFractions } from '${urls.coverCrop}'
export { storedAiSettings, withMeteredAccepted } from '${urls.aiStream}'
export const EMU_PER_PX_96 = 9525
export const PRODUCT_NAME = G().host.product ?? 'SeuOffice'
export const setAiUserAgent = (ua) => G().log('setAiUserAgent', ua)
export const setRescueFetch = () => G().log('setRescueFetch')
export const shutdownCodexAppServers = () => {}
export const ensureSubscriptionIpc = (_ipc, deps) => {
  G().subscription = deps
  G().log('ensureSubscriptionIpc', deps.dataDir)
}
export const sharedSubscriptionStatuses = () => {
  G().log('sharedSubscriptionStatuses')
  return G().host.statuses ?? {}
}
export const fetchRemoteImage = (url) => G().fetchRemoteImage(url)
export const readBodyCapped = (resp, max) => G().readBodyCapped(resp, max)
export const webSearchTool = (path, query, max) => G().tool('webSearchTool', [path, query, max])
export const imageSearchTool = (path, query, max) => G().tool('imageSearchTool', [path, query, max])
export const readUrlTool = (path, url, offset, opts) => G().tool('readUrlTool', [path, url, offset], opts)
export const generateImageTool = (path, request, opts) => G().tool('generateImageTool', [path, request, { mediaRoots: opts.mediaRoots, context: opts.context }], opts)
export const analyzeMediaTool = (path, request, opts) => G().tool('analyzeMediaTool', [path, request, { mediaRoots: opts.mediaRoots, context: opts.context }], opts)
export const aiToolCapabilities = (settings, context) => {
  G().log('aiToolCapabilities', settings, context)
  return G().host.capabilities ?? { webSearch: { available: true } }
}
export const documentLocale = () => { G().log('documentLocale'); return G().host.locale ?? 'en' }
export const getUiLang = () => { G().log('getUiLang'); return G().host.uiLang ?? 'en' }
export const aiSubscriptionLoginWindowText = (lang, provider) => {
  G().log('aiSubscriptionLoginWindowText', lang, provider)
  return { lang, provider }
}
export const aiChatGptSignInPages = (lang) => { G().log('aiChatGptSignInPages', lang); return { pages: lang } }
export const addPicture = (_opened, slide, op) => G().addPicture(slide, op)
export const editPictureSrcRect = (slide, id, crop) => G().editPictureSrcRect(slide, id, crop)
export const replacePictureBytes = (_opened, slide, id, bytes, ext, options) => G().replacePictureBytes(slide, id, bytes, ext, options)
export const matchesElementRef = (el, ref) => el.ref === ref
export const runAiStream = (run) => G().runAiStream(run)
export const tm = (key, params) => 'tm:' + key + (params === undefined ? '' : ':' + JSON.stringify(params))
export const registerTemplateSelectionIpc = () => {}
`

const SLIDES_STUB = `
export const materializeSlide = () => null
export const parseClrMap = () => ({})
export const parseTheme = () => ({})
export const resolveSchemeColor = () => undefined
export const buildRenderSlide = () => null
export const createSystemFontMetrics = () => ({})
export const resetFontRegistry = () => {}
export const tiffToPng = () => null
`

const WRAPPER_SOURCE = (sessionUrl: string): string => `
export * from '${sessionUrl}'
export const buildAllRenderSlides = (opened, fit) =>
  opened.deck.slides.map((s, i) => ({ partPath: s.path, slideNo: i + 1, fitWidthPx: fit }))
export const rebuildSlide = (session, i) => globalThis.__b5SlidesAi.rebuildSlide(session, i)
`

/** every library the module imports that the case drives (the rest stays real) */
const STUBBED_SPECS = [
  '@seuoffice/ai-provider',
  '@seuoffice/ai-provider/codex-app-server',
  '@seuoffice/ai-provider/key-models',
  '@seuoffice/ai-provider/subscription',
  '@seuoffice/electron-utils',
  '@seuoffice/electron-utils/ai-run-guard',
  '@seuoffice/ai-search',
  '@seuoffice/i18n',
  '@seuoffice/pptx-engine',
  '@seuoffice/pptx-engine/identity',
  '@seuoffice/pipelines/slides',
  '@seuoffice/ui/ai-subscription-login-window',
  '@seuoffice/pptx-render',
  './ai-stream',
  './i18n-main',
  './template-selection-ipc',
]

interface Clock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  fireNext: () => boolean
  advanceTo: (to: number) => void
}

/** the virtual clock of the proposal module: time moves only when a call waits */
function makeClock(): Clock {
  let now = 0
  let seq = 0
  const timers: { id: number; at: number; fn: () => void; live: boolean }[] = []
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1
      timers.push({ id: seq, at: now + ms, fn, live: true })
      return seq
    },
    clearTimeout: (id) => {
      const timer = timers.find((t) => t.id === id)
      if (timer) timer.live = false
    },
    fireNext: () => {
      let best: (typeof timers)[number] | undefined
      for (const timer of timers) {
        if (!timer.live) continue
        if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id))
          best = timer
      }
      if (!best) return false
      best.live = false
      now = Math.max(now, best.at)
      best.fn()
      return true
    },
    advanceTo: (to) => {
      for (;;) {
        let best: (typeof timers)[number] | undefined
        for (const timer of timers) {
          if (!timer.live || timer.at > to) continue
          if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id))
            best = timer
        }
        if (!best) break
        best.live = false
        now = Math.max(now, best.at)
        best.fn()
      }
      now = Math.max(now, to)
    },
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((done) => setImmediate(done))
}

const hexOf = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('hex')

const DEFAULT_SIZE = { cx: 9144000, cy: 5143500 }

const snapJson = (s: J): J => ({ slides: s.slides, size: s.size, metaDirty: s.metaDirty })

async function runWorld(spec: J, cx: TsContext): Promise<J> {
  const host: J = spec.host ?? {}
  const clock = makeClock()
  const log = cx.log
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx: J = {
    log,
    host,
    now: cx.now,
    vt: clock,
    subscription: null,
    during: null,
    // the timers of the session state are never run: its flags say what was queued
    immediate: () => undefined,
  }
  g.__b5SlidesAi = ctx

  // the modules, as copies over the stubs
  const slidesStub = scratchFile('slides-stub.mjs', SLIDES_STUB)
  const sessionUrl = patchedUrl(`${MAIN}session-state.ts`, (src) => {
    let out = src
    for (const from of [
      '@seuoffice/pptx-engine',
      '@seuoffice/pptx-render',
      './fonts',
      './tiff-decode',
    ]) {
      out = must(out, `from '${from}'`, `from '${slidesStub}'`, 'session-state.ts')
    }
    out = must(
      out,
      "import { randomUUID } from 'node:crypto'",
      'const randomUUID = (): string => "uuid"',
      'session-state.ts',
    )
    out = must(out, 'setImmediate(', 'globalThis.__b5SlidesAi.immediate(', 'session-state.ts')
    return must(out, '__dirname', "'/dist/main'", 'session-state.ts')
  })
  const wrapperUrl = scratchFile('session-wrapper.mjs', WRAPPER_SOURCE(sessionUrl))
  const libUrl = scratchFile(
    'lib.mjs',
    LIB_SOURCE({
      mediaCallAbort: repoUrl('packages/ai-search/src/media-call-abort.ts'),
      mediaTools: repoUrl('packages/ai-search/src/media-tools.ts'),
      coverCrop: repoUrl('packages/pipelines/src/slides/cover-crop.ts'),
      aiStream: repoUrl(`${MAIN}ai-stream.ts`),
    }),
  )

  // electron
  const wcs = (host.windows ?? []).map((w: J, i: number) => ({
    isDestroyed: () => {
      log('wcIsDestroyed', i)
      return !!w.destroyed
    },
    send: (...rest: unknown[]) => log('wcSend', i, ...rest),
  }))
  const native: J = host.native ?? {}
  useElectron({
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return host.userData
        if (name === 'temp') return host.temp
        throw new Error(`getPath ${name}`)
      },
      getVersion: () => host.version ?? '1.2.3',
      once: (event: string) => log('appOnce', event),
    },
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      on() {},
    },
    nativeImage: {
      createFromBuffer: (buf: Uint8Array) => {
        const hex = hexOf(buf)
        log('createFromBuffer', hex)
        const conf = {
          empty: false,
          png: '89504e47',
          size: { width: 100, height: 100 },
          ...native[hex],
        }
        return {
          isEmpty: () => {
            log('isEmpty')
            return !!conf.empty
          },
          toPNG: () => {
            log('toPNG')
            return Buffer.from(conf.png, 'hex')
          },
          getSize: () => {
            log('getSize')
            return conf.size
          },
        }
      },
    },
    shell: {
      openExternal: async (url: string) => {
        log('openExternal', url)
        if (host.openExternal === 'reject') throw new Error('no browser')
      },
    },
    webContents: { getAllWebContents: () => wcs },
  })
  setAiRunGuard(
    host.guard
      ? (input: J) => {
          log('aiRunGuard', input)
          return host.guard[input.provider] ?? null
        }
      : null,
  )
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => log('warn', ...args)

  // the world's stubs
  const engine: J = host.engine ?? {}
  ctx.tool = async (name: string, args: unknown[], opts?: J) => {
    const conf = host.tools?.[name] ?? {}
    log(name, ...args, ...(opts ? [opts.signal.aborted] : []))
    if (conf.throws !== undefined) throw new Error(conf.throws)
    return conf.answer ?? { ok: true }
  }
  ctx.fetchRemoteImage = async (url: string) => {
    log('fetchRemoteImage', url)
    if (ctx.during) {
      const steps = ctx.during
      ctx.during = null
      for (const step of steps) runSync(step)
    }
    const resp = host.net?.[url]
    return resp ? { ok: resp.ok !== false, hex: resp.hex, tooLarge: !!resp.tooLarge } : null
  }
  ctx.readBodyCapped = async (resp: J, max: number) => {
    log('readBodyCapped', max)
    if (resp.tooLarge) throw new Error('response too large')
    return Uint8Array.from(Buffer.from(resp.hex, 'hex'))
  }
  ctx.addPicture = (slide: J, op: J) => {
    log('addPicture', slide.path, hexOf(op.bytes), op.ext, op.offset)
    if (engine.addPicture === 'throw') throw new Error('addPicture failed')
    return engine.addPicture === null ? null : { id: engine.addPicture?.id ?? 'pic-new' }
  }
  ctx.editPictureSrcRect = (slide: J, id: string, crop: J) => {
    log('editPictureSrcRect', slide.path, id, crop)
    if (engine.crop === 'throw') throw new Error('crop failed')
  }
  ctx.replacePictureBytes = (slide: J, id: string, bytes: Uint8Array, ext: string, options: J) => {
    log('replacePictureBytes', slide.path, id, hexOf(bytes), ext, options ?? null)
    if (engine.replace === 'throw') throw new Error('replace failed')
    return engine.replace !== false
  }
  ctx.rebuildSlide = (session: J, index: number) => {
    log('rebuildSlide', index, session.fitWidthPx)
    return engine.rebuild === null ? null : { rebuilt: index, fit: session.fitWidthPx }
  }
  ctx.runAiStream = async (run: J) => {
    log('runAiStream', run.request, run.settings, run.statuses)
    for (const op of host.stream?.script ?? []) {
      if ('send' in op) run.send(op.send)
      else if ('cancel' in op) {
        await handlers.get('ai:stream-cancel')!(
          { sender: senderOf(op.sender ?? 1).object },
          op.cancel,
        )
      } else if ('destroy' in op) senderOf(op.destroy).destroy()
      else if ('observe' in op) log('aborted', run.signal.aborted)
      else if ('throw' in op) throw new Error(op.throw)
    }
  }

  const proposalUrl = patchedUrl(`${MAIN}ai-proposal.ts`, (src) => {
    let out = must(src, "from './session-state'", `from '${wrapperUrl}'`, 'ai-proposal.ts')
    out = must(out, 'Date.now()', 'globalThis.__b5SlidesAi.vt.now()', 'ai-proposal.ts')
    out = must(out, 'setTimeout(', 'globalThis.__b5SlidesAi.vt.setTimeout(', 'ai-proposal.ts')
    return must(out, 'clearTimeout(', 'globalThis.__b5SlidesAi.vt.clearTimeout(', 'ai-proposal.ts')
  })
  const ipcUrl = patchedUrl(`${MAIN}ai-ipc.ts`, (src) => {
    let out = src
    for (const from of STUBBED_SPECS)
      out = must(out, `from '${from}'`, `from '${libUrl}'`, 'ai-ipc.ts')
    out = must(out, "from './session-state'", `from '${wrapperUrl}'`, 'ai-ipc.ts')
    return must(
      out,
      'new Date().toISOString()',
      'new Date(globalThis.__b5SlidesAi.now).toISOString()',
      'ai-ipc.ts',
    )
  })
  const ss: J = await import(wrapperUrl)
  const proposal: J = await import(proposalUrl)
  const ipc: J = await import(ipcUrl)
  proposal.registerAiProposalIpc()
  ipc.registerSlidesOnlyAiIpc()

  // sessions and senders
  const sizeOf = (conf: J): J => ({ ...(conf.size ?? DEFAULT_SIZE) })
  const makeSession = (conf: J): J => ({
    path: conf.path ?? '',
    opened: {
      deck: { slides: structuredClone(conf.slides ?? []), size: sizeOf(conf) },
      archive: { entries: new Map() },
    },
    fitWidthPx: conf.fit ?? 960,
    undoStack: [],
    redoStack: [],
  })
  const mainConf = spec.session === undefined ? {} : spec.session
  const main = mainConf === null ? null : makeSession(mainConf)
  const other = makeSession(spec.other ?? {})
  const mainWc: number = mainConf?.wc ?? 1
  if (main) ss.sessions.set(mainWc, main)
  const session = (): J => main

  const senders = new Map<number, J>()
  function senderOf(id: number): J {
    const known = senders.get(id)
    if (known) return known
    const conf = spec.senders?.[String(id)] ?? {}
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const state = { destroyed: !!conf.destroyed }
    const add = (event: string, fn: (...a: unknown[]) => void): void => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
    }
    const object: J = {
      id,
      send: (channel: string, payload: unknown) => log('send', id, channel, payload),
      once: (event: string, fn: (...a: unknown[]) => void) => {
        log('once', id, event, fn.name)
        add(event, fn)
      },
      removeListener: (event: string, fn: (...a: unknown[]) => void) => {
        log('removeListener', id, event, fn.name)
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((f) => f !== fn),
        )
      },
    }
    if (!conf.noIsDestroyed) {
      object.isDestroyed = () => {
        log('isDestroyed', id)
        return state.destroyed
      }
    }
    if (conf.hasOn !== false) {
      object.on = (event: string, fn: (...a: unknown[]) => void) => {
        log('on', id, event, fn.name)
        add(event, fn)
      }
    }
    const made = {
      object,
      destroy: () => {
        state.destroyed = true
        const fns = listeners.get('destroyed') ?? []
        listeners.set('destroyed', [])
        for (const fn of fns) fn()
      },
      markDestroyed: () => {
        state.destroyed = true
      },
    }
    senders.set(id, made)
    return made
  }

  // the steps
  const writes: { id: string; promise: Promise<void> }[] = []
  const projectMarker = (marker: J): J => ({
    undoTop: marker.undoTop === undefined ? -1 : session().undoStack.indexOf(marker.undoTop),
    undoLen: marker.undoLen,
    redoLen: marker.redoLen,
    opSeq: marker.opSeq,
    metaRev: marker.metaRev,
  })
  const stateJson = (): J => {
    const s = session()
    if (!s) return null
    return {
      path: s.path,
      undo: s.undoStack.map(snapJson),
      redo: s.redoStack.map(snapJson),
      batch: s.historyBatch
        ? {
            depth: s.historyBatch.depth,
            undoStart: s.historyBatch.undoStart,
            before: snapJson(s.historyBatch.before),
          }
        : null,
      aiSnapshots: s.aiSnapshots
        ? [...s.aiSnapshots].map(([id, snap]: [number, J]) => [id, snapJson(snap)])
        : null,
      aiRun: s.aiRun
        ? {
            owner: s.aiRun.owner,
            before: snapJson(s.aiRun.before),
            undo: s.aiRun.undo.length,
            redo: s.aiRun.redo.length,
            opSeq: s.aiRun.opSeq,
            metaRev: s.aiRun.metaRev,
            known: [...s.aiRun.knownSnapshots],
          }
        : null,
      proposal: s.aiProposal
        ? {
            owner: s.aiProposal.owner,
            before: snapJson(s.aiProposal.before),
            after: snapJson(s.aiProposal.after),
            marker: projectMarker(s.aiProposal.marker),
          }
        : null,
      masterEdit: !!s.masterEdit,
      metaDirty: !!s.metaDirty,
      metaRev: s.metaRev ?? null,
      opSeq: s.opSeq ?? null,
      opLog: s.opLog ?? null,
      notify: !!s.historyNotifyScheduled,
      broadcast: !!s.deckBroadcastScheduled,
      updates: s.deckBroadcastUpdates ? s.deckBroadcastUpdates.length : null,
      writes: s.writesInFlight ? s.writesInFlight.size : 0,
      fit: s.fitWidthPx,
      deck: { slides: s.opened.deck.slides, size: s.opened.deck.size },
    }
  }

  /** the steps that run in one task: nothing here waits */
  function runSync(step: J): J {
    const s = session()
    switch (step.op) {
      case 'edit':
        if (step.slides) s.opened.deck.slides = structuredClone(step.slides)
        if (step.size) s.opened.deck.size = { ...step.size }
        return null
      case 'push':
        ss.pushHistory(s)
        return null
      case 'pushRedo':
        s.redoStack.push(ss.takeSnapshot(s))
        return null
      case 'popUndo':
        s.undoStack.pop()
        return null
      case 'meta':
        ss.markMetaDirty(s)
        return null
      case 'journal':
        ss.journalOps(s, 'edit', step.records)
        return null
      case 'masterEdit':
        s.masterEdit = step.on ? { partPath: 'master', slide: {} } : null
        return null
      case 'batch':
        ss.beginHistoryBatch(s)
        return null
      case 'registerAi':
        return ss.registerAiSnapshot(s, ss.takeSnapshot(s))
      case 'begin':
        return proposal.beginAiRun(s, step.owner)
      case 'hold':
        return proposal.holdAiRun(s, step.owner)
      case 'accept':
        return proposal.acceptAiProposal(s)
      case 'reject':
        return proposal.rejectAiProposal(s)
      case 'drop':
        proposal.dropAiRunOf(s, step.owner)
        return null
      case 'marker':
        return projectMarker(proposal.markerOf(s))
      case 'assert':
        try {
          proposal.assertNoAiRun(s)
          return { ok: true }
        } catch (error) {
          return { error: (error as Error).message }
        }
      case 'sidecar':
        return ipc.styleSkillSidecarPath(step.path)
      case 'replaceSession':
        ss.sessions.set(step.wc ?? mainWc, other)
        return null
      case 'destroy':
        senderOf(step.sender ?? 1).markDestroyed()
        return null
      default:
        throw new Error(`no such step: ${step.op}`)
    }
  }

  /** `promise` once the virtual clock has run until it settles */
  async function drive(promise: Promise<unknown>): Promise<unknown> {
    let done = false
    let failed = false
    let value: unknown
    promise.then(
      (v) => {
        done = true
        value = v
      },
      (e) => {
        done = true
        failed = true
        value = e
      },
    )
    for (let turn = 0; turn < 10_000 && !done; turn += 1) {
      await flush()
      if (done) break
      if (!clock.fireNext()) throw new Error('the call never settles')
    }
    if (failed) throw value
    return value
  }

  const failure = (error: J): J => ({
    error: error?.message ?? String(error),
    code: error?.code ?? null,
  })

  async function runStep(step: J): Promise<J> {
    switch (step.op) {
      case 'track': {
        const write = (): Promise<void> =>
          new Promise<void>((done, fail) => {
            if (step.after === null) return
            clock.setTimeout(
              () => (step.rejects ? fail(new Error('write failed')) : done()),
              step.after,
            )
          })
        let refused: string | null = null
        const pending = proposal.trackWrite(session(), write)
        pending.catch((error: Error) => {
          refused ??= error.message
        })
        await flush()
        writes.push({ id: step.id, promise: pending })
        return refused === null ? { started: true } : { error: refused }
      }
      case 'settle': {
        const settled = await drive(proposal.settleWrites(session()))
        return { settled, at: clock.now() }
      }
      case 'advance': {
        // the clock moves on to `to`, firing what is due
        clock.advanceTo(step.to)
        await flush()
        return { at: clock.now() }
      }
      case 'setup':
        ipc.registerAiIpc()
        return null
      case 'subDep': {
        const deps = ctx.subscription
        switch (step.name) {
          case 'getSettings':
            return deps.getSettings()
          case 'setMeteredAccepted':
            try {
              deps.setMeteredAccepted(...step.args)
              return null
            } catch (error) {
              return failure(error)
            }
          case 'loginWindowText':
            return deps.loginWindowText(...step.args)
          case 'broadcast':
            deps.broadcast(...step.args)
            return null
          case 'openBrowser':
            return await deps.chatGptSignIn.openBrowser(...step.args)
          case 'pages':
            return deps.chatGptSignIn.pages()
          default:
            throw new Error(`no such dep: ${step.name}`)
        }
      }
      case 'invoke': {
        const handler = handlers.get(step.channel)
        if (!handler) return { error: `no handler: ${step.channel}`, code: null }
        const event = { sender: senderOf(step.sender ?? 1).object }
        try {
          if (step.channel !== 'slides:ai-run-begin') ctx.during = step.during ?? null
          const pending = handler(event, ...(step.args ?? [])) as Promise<unknown>
          if (step.channel === 'slides:ai-run-begin') {
            for (const during of step.during ?? []) runSync(during)
          }
          const value = await drive(Promise.resolve(pending))
          return value === undefined ? null : value
        } catch (error) {
          return failure(error)
        } finally {
          ctx.during = null
        }
      }
      default:
        return runSync(step)
    }
  }

  const results: J[] = []
  try {
    for (const step of spec.steps) results.push(await runStep(step))
    await flush()
    return { steps: results, state: stateJson() }
  } finally {
    console.warn = realWarn
    setAiRunGuard(null)
    for (const id of [...ss.sessions.keys()]) ss.sessions.delete(id)
  }
}

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

const D = '$DIR'

/** a world: the host's paths, the rest as given */
function world(spec: J): J {
  const { host, ...rest } = spec
  return { host: { userData: `${D}/ud`, temp: `${D}/tmp`, ...host }, ...rest }
}

const c = (spec: J, note?: string, files?: Case['files']): Case => ({
  args: [world(spec)],
  ...(note ? { note } : {}),
  ...(files ? { files } : {}),
})

const S1 = { path: 'ppt/slides/slide1.xml', t: 'one', elements: [] }
const S2 = { path: 'ppt/slides/slide2.xml', t: 'two', elements: [] }
const S3 = { path: 'ppt/slides/slide3.xml', t: 'three', elements: [] }

const edit = (...slides: J[]): J => ({ op: 'edit', slides })
const begin = (owner = 1): J => ({ op: 'begin', owner })
const hold = (owner = 1): J => ({ op: 'hold', owner })
const push: J = { op: 'push' }
const accept: J = { op: 'accept' }
const invoke = (channel: string, args: J[] = [], rest: J = {}): J => ({
  op: 'invoke',
  channel,
  args,
  ...rest,
})
const settings = (extra: J = {}): J => ({ provider: 'auto', providers: {}, ...extra })

/** a run that edited the deck and was held: the proposal is the edit to slide two */
const heldRun: J[] = [begin(), push, edit(S1, S2), hold()]

const run = (spec: J, cx: TsContext): Promise<J> => runWorld(spec, cx)
const scenario = (cases: Case[]): FnSpec => ({ ts: (a, cx) => run(a[0], cx), cases })

// ---- ai-proposal ----

const proposalCases = {
  begin: [
    c(
      { session: { slides: [S1] }, steps: [begin()] },
      'a run is recorded, the history notice queued',
    ),
    c(
      { session: { slides: [S1] }, steps: [{ op: 'masterEdit', on: true }, begin(), begin(2)] },
      'a deck in master view cannot be reverted',
    ),
    c(
      { session: { slides: [S1] }, steps: [begin(1), begin(2), { op: 'assert' }] },
      "another window's run is still open",
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [begin(), push, edit(S1, S2), begin(), { op: 'marker' }],
      },
      'a run of this window that was never held is reverted first, then replaced',
    ),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, begin(), { op: 'accept' }] },
      'a proposal still held from an earlier request is dropped',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'registerAi' },
          { op: 'registerAi' },
          begin(),
          { op: 'registerAi' },
          push,
          hold(),
        ],
      },
      'rollback points that existed before the run are kept, later ones are not',
    ),
    c(
      { session: { slides: [S1] }, steps: [{ op: 'pushRedo' }, begin(), push, edit(S2), hold()] },
      'both stacks come back',
    ),
  ],
  hold: [
    c({ session: { slides: [S1] }, steps: [hold()] }, 'nothing to hold'),
    c(
      { session: { slides: [S1] }, steps: [begin(), hold(), { op: 'assert' }] },
      'a run that changed nothing',
    ),
    c(
      { session: { slides: [S1] }, steps: heldRun },
      'the deck is put back, the result is the proposal',
    ),
    c(
      { session: { slides: [S1] }, steps: [begin(1), hold(2), { op: 'assert' }] },
      'only the window that began it',
    ),
    c(
      { session: { slides: [S1] }, steps: [begin(), { op: 'batch' }, push, edit(S2), hold()] },
      'a history batch the run left open is dropped',
    ),
    c(
      { session: { slides: [S1] }, steps: [begin(), { op: 'meta' }, hold()] },
      'a notes edit that left no undo step is a change',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [begin(), { op: 'journal', records: [{ op: { kind: 'x' } }] }, hold()],
      },
      'an op that left no undo step is a change',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [begin(), { op: 'registerAi' }, push, edit(S3), hold()],
      },
      'a rollback point made by the run is dropped',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          push,
          edit(S1),
          begin(),
          { op: 'popUndo' },
          push,
          edit(S2),
          hold(),
          { op: 'marker' },
        ],
      },
      'the same number of steps, but not the same steps',
    ),
  ],
  accept: [
    c({ session: { slides: [S1] }, steps: [accept] }, 'no proposal'),
    c({ session: { slides: [S1] }, steps: [...heldRun, accept] }, 'the run becomes one undo step'),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, push, accept, { op: 'marker' }] },
      'the person edited since the revert',
    ),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, { op: 'meta' }, accept] },
      'a notes edit since the revert',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [...heldRun, { op: 'journal', records: [{ op: {} }] }, accept],
      },
      'an op since the revert',
    ),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, { op: 'batch' }, accept] },
      'a history batch is open',
    ),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, { op: 'masterEdit', on: true }, accept] },
      'the deck is in master view',
    ),
    c({ session: { slides: [S1] }, steps: [...heldRun, accept, accept] }, 'accepted once'),
    c(
      {
        session: { slides: [S1] },
        steps: [
          push,
          begin(),
          push,
          edit(S1, S2),
          hold(),
          { op: 'popUndo' },
          push,
          accept,
          { op: 'marker' },
        ],
      },
      "the person's edit left the same counts but is not the same step",
    ),
    c(
      { session: { slides: [S1] }, steps: [push, begin(), push, edit(S1, S2), hold(), accept] },
      'the same stacks as the revert left them',
    ),
  ],
  reject: [
    c({ session: { slides: [S1] }, steps: [{ op: 'reject' }] }, 'no proposal'),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, { op: 'reject' }, accept] },
      'dropped, so it cannot be accepted',
    ),
  ],
  drop: [
    c(
      { session: { slides: [S1] }, steps: [begin(), push, edit(S2), { op: 'drop', owner: 1 }] },
      'its run is reverted as a reject would',
    ),
    c(
      { session: { slides: [S1] }, steps: [begin(1), { op: 'drop', owner: 2 }, { op: 'assert' }] },
      "another window's run stays",
    ),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, { op: 'drop', owner: 1 }, accept] },
      'its proposal is dropped',
    ),
    c(
      { session: { slides: [S1] }, steps: [...heldRun, { op: 'drop', owner: 2 }, accept] },
      "another window's proposal stays",
    ),
  ],
  marker: [
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'marker' },
          push,
          { op: 'marker' },
          { op: 'pushRedo' },
          { op: 'marker' },
          { op: 'meta' },
          { op: 'marker' },
          { op: 'journal', records: [{ op: { kind: 'x' } }] },
          { op: 'marker' },
        ],
      },
      'the marker follows the stacks and counters',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          push,
          push,
          { op: 'marker' },
          { op: 'journal', records: [{ op: {} }, { op: {} }] },
          { op: 'marker' },
        ],
      },
      'two steps, a journal entry of two ops',
    ),
  ],
  assert: [
    c(
      { session: { slides: [S1] }, steps: [{ op: 'assert' }, begin(), { op: 'assert' }] },
      'open and closed',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [...heldRun, { op: 'assert' }, begin(2), { op: 'assert' }],
      },
      "a held proposal is no open run; another window's run is",
    ),
  ],
  track: [
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'track', id: 'w1', after: 100 },
          { op: 'track', id: 'w2', after: null },
        ],
      },
      'two writes in flight',
    ),
    c(
      { session: { slides: [S1] }, steps: [begin(), { op: 'track', id: 'w1', after: 100 }] },
      'refused while a run is open',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'track', id: 'w1', after: 10, rejects: true },
          { op: 'advance', to: 20 },
        ],
      },
      'a write that fails is no longer in flight',
    ),
  ],
  settle: [
    c({ session: { slides: [S1] }, steps: [{ op: 'settle' }] }, 'quiet'),
    c(
      {
        session: { slides: [S1] },
        steps: [{ op: 'track', id: 'w', after: 100 }, { op: 'settle' }],
      },
      'waits for the write',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [{ op: 'track', id: 'w', after: null }, { op: 'settle' }],
      },
      'a write that never ends times out',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [{ op: 'track', id: 'w', after: 40000 }, { op: 'settle' }],
      },
      'a write past the deadline',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [{ op: 'track', id: 'w', after: 20000 }, { op: 'settle' }],
      },
      'a write that takes a long while but ends in time',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [{ op: 'track', id: 'w', after: 30000 }, { op: 'settle' }],
      },
      'a write that ends at the deadline',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'track', id: 'a', after: 10 },
          { op: 'track', id: 'b', after: 50 },
          { op: 'settle' },
        ],
      },
      'two writes',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [{ op: 'track', id: 'a', after: 10, rejects: true }, { op: 'settle' }],
      },
      'a failed write settles too',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'track', id: 'a', after: 10 },
          { op: 'advance', to: 5 },
          { op: 'track', id: 'b', after: null },
          { op: 'settle' },
          { op: 'settle' },
        ],
      },
      'the second wait starts late and has its own deadline',
    ),
  ],
  ipc: [
    c(
      {
        session: null,
        steps: [
          invoke('slides:ai-run-begin'),
          invoke('slides:ai-run-hold'),
          invoke('slides:ai-proposal-accept'),
          invoke('slides:ai-proposal-reject'),
        ],
      },
      'a window without a session',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [invoke('slides:ai-run-begin'), invoke('slides:ai-run-hold'), { op: 'assert' }],
      },
      'a run that changed nothing is not held',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('slides:ai-run-begin'),
          push,
          edit(S1, S2),
          invoke('slides:ai-run-hold'),
          invoke('slides:ai-proposal-accept'),
          invoke('slides:ai-proposal-accept'),
        ],
      },
      'begin, hold, accept',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('slides:ai-run-begin'),
          push,
          edit(S1, S2),
          invoke('slides:ai-run-hold'),
          invoke('slides:ai-proposal-reject'),
          invoke('slides:ai-proposal-reject'),
        ],
      },
      'reject twice',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('slides:ai-run-begin', [], { sender: 2 }),
          invoke('slides:ai-run-begin', [], { sender: 1 }),
          invoke('slides:ai-run-hold', [], { sender: 1 }),
        ],
      },
      'a run of another window blocks, and cannot be held by this one',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'track', id: 'w', after: 100 },
          invoke('slides:ai-run-begin'),
          { op: 'assert' },
        ],
      },
      'the begin waits for a write that began before it',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          { op: 'track', id: 'w', after: null },
          invoke('slides:ai-run-begin'),
          { op: 'assert' },
        ],
      },
      'a write that never ends: no run',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('slides:ai-run-begin', [], { during: [{ op: 'drop', owner: 1 }] }),
          { op: 'assert' },
        ],
      },
      'the window was dropped while its begin waited',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('slides:ai-run-begin', [], { during: [{ op: 'destroy', sender: 1 }] }),
          { op: 'assert' },
        ],
      },
      'the window went away while its begin waited',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('slides:ai-run-begin', [], { during: [{ op: 'replaceSession' }] }),
          { op: 'assert' },
        ],
      },
      'the window has another session now',
    ),
    c(
      {
        session: { slides: [S1] },
        senders: { '1': { noIsDestroyed: true } },
        steps: [invoke('slides:ai-run-begin'), { op: 'assert' }],
      },
      'a sender without isDestroyed',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('slides:ai-run-begin', [], { during: [{ op: 'drop', owner: 2 }] }),
          { op: 'assert' },
        ],
      },
      'another window was dropped: this begin goes on',
    ),
  ],
}

// ---- ai-ipc: the generic handlers ----

const goodSettings = settings({
  provider: 'openai',
  providers: { openai: { apiKey: 'sk-1', model: 'gpt-x', models: ['stale'] } },
})
const windows2 = [{ destroyed: false }, { destroyed: true }, { destroyed: false }]
const storedFile = JSON.stringify({
  provider: 'openai',
  providers: { openai: { apiKey: 'sk-0', model: 'gpt-y', models: ['m1', 'm2'], futureKey: 7 } },
  subscriptionOff: { claude: true },
  futureTop: { a: 1 },
})
const failure = (extra: J = {}): J => ({
  kind: 'repetition',
  provider: 'openai',
  instruction: 'make slides',
  streamed: 'abcdef',
  ...extra,
})

const aiCases = {
  setup: [
    c(
      { steps: [{ op: 'setup' }] },
      'the quit hook, the rescue fetch, the user agent, the subscriptions',
    ),
    c(
      { host: { version: '9.9.9', product: 'Other' }, steps: [{ op: 'setup' }] },
      'the user agent follows the product and the version',
    ),
  ],
  getSettings: [
    c({ steps: [{ op: 'setup' }, invoke('ai:get-settings')] }, 'no file: the defaults'),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:get-settings')] },
      'a stored file as the app reads it',
      { 'ud/ai-settings.json': storedFile },
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:get-settings')] },
      'a damaged file falls to the defaults',
      { 'ud/ai-settings.json': '{ not json' },
    ),
    c({ steps: [{ op: 'setup' }, invoke('ai:get-settings')] }, 'a file that holds null', {
      'ud/ai-settings.json': 'null',
    }),
  ],
  setSettings: [
    c(
      {
        host: { windows: windows2 },
        steps: [{ op: 'setup' }, invoke('ai:set-settings', [goodSettings])],
      },
      'sanitized, written, broadcast to the live windows',
    ),
    c(
      {
        host: { windows: windows2 },
        steps: [{ op: 'setup' }, invoke('ai:set-settings', [goodSettings])],
      },
      'the file keeps the live model lists, the CLIs turned off and the fields a newer build wrote',
      { 'ud/ai-settings.json': storedFile },
    ),
    c(
      {
        host: { windows: windows2 },
        steps: [{ op: 'setup' }, invoke('ai:set-settings', [{ provider: 'bogus', providers: {} }])],
      },
      'an invalid payload is refused and warned about',
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:set-settings', ['not an object'])] },
      'not even an object',
    ),
    c({ steps: [{ op: 'setup' }, invoke('ai:set-settings')] }, 'nothing sent'),
  ],
  logRunFailure: [
    c(
      { steps: [{ op: 'setup' }, invoke('ai:log-run-failure', [failure()])] },
      'one line, the clock and the length of the streamed text',
    ),
    c(
      {
        steps: [
          { op: 'setup' },
          invoke('ai:log-run-failure', [failure()]),
          invoke('ai:log-run-failure', [failure({ instruction: 'again' })]),
        ],
      },
      'a second line is appended',
    ),
    c(
      {
        steps: [
          { op: 'setup' },
          invoke('ai:log-run-failure', [
            failure({ instruction: 'x'.repeat(20005), streamed: 'y'.repeat(30000) }),
          ]),
        ],
      },
      'a long text is cut, its length kept',
    ),
    c(
      {
        steps: [
          { op: 'setup' },
          invoke('ai:log-run-failure', [failure({ ts: 'mine', streamedChars: 1 })]),
        ],
      },
      'keys of the entry keep their place',
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:log-run-failure', [{ kind: 'x' }])] },
      'an entry without its texts is dropped',
    ),
    c({ steps: [{ op: 'setup' }, invoke('ai:log-run-failure', [null])] }, 'null'),
    c({ steps: [{ op: 'setup' }, invoke('ai:log-run-failure')] }, 'nothing sent'),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:log-run-failure', [failure()])] },
      'a log past two megabytes is rotated first',
      { 'ud/ai-run-failures.jsonl': { text: 'z'.repeat(2_000_001) } },
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:log-run-failure', [failure()])] },
      'a log at two megabytes is kept',
      { 'ud/ai-run-failures.jsonl': { text: 'z'.repeat(2_000_000) } },
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:log-run-failure')] },
      'rotated even when the entry is dropped',
      { 'ud/ai-run-failures.jsonl': { text: 'z'.repeat(2_000_001) } },
    ),
    c(
      {
        steps: [
          { op: 'setup' },
          invoke('ai:log-run-failure', [failure({ instruction: ['a', 'b'], streamed: ['c'] })]),
        ],
      },
      'lists have a slice and a length too',
    ),
  ],
  stream: [
    c(
      {
        host: {
          stream: {
            script: [{ send: { requestId: 'r1', type: 'text', text: 'hi' } }, { observe: 1 }],
          },
        },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'the chunks the run sends reach the window',
    ),
    c(
      {
        steps: [
          { op: 'setup' },
          invoke('ai:stream', [
            { requestId: 'r1', settings: { provider: 'bogus', providers: {} } },
          ]),
        ],
      },
      'invalid settings: an error chunk, no run',
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:stream', [{ settings: 5 }])] },
      'invalid settings and no request id',
    ),
    c({ steps: [{ op: 'setup' }, invoke('ai:stream')] }, 'no request'),
    c({ steps: [{ op: 'setup' }, invoke('ai:stream', [null])] }, 'a null request'),
    c(
      {
        host: { guard: { openai: 'free provider refused' } },
        steps: [
          { op: 'setup' },
          invoke('ai:stream', [{ requestId: 'r2', settings: goodSettings }]),
        ],
      },
      'the run guard refuses a provider',
    ),
    c(
      {
        host: { guard: { claude: 'x' } },
        steps: [
          { op: 'setup' },
          invoke('ai:stream', [{ requestId: 'r2', settings: goodSettings }]),
        ],
      },
      'the run guard does not know this provider: the run goes',
    ),
    c(
      {
        senders: { '1': { destroyed: true } },
        host: { guard: { openai: 'refused' } },
        steps: [
          { op: 'setup' },
          invoke('ai:stream', [{ requestId: 'r2', settings: goodSettings }]),
        ],
      },
      'a refusal does not reach a window that is gone',
    ),
    c(
      {
        host: { guard: { auto: 'no auto' } },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r3', settings: settings() }])],
      },
      'auto has no config: the model is empty',
    ),
    c(
      {
        host: {
          statuses: { claude: { state: 'ready' } },
          stream: {
            script: [{ cancel: 'r1' }, { observe: 1 }, { send: { requestId: 'r1', type: 'done' } }],
          },
        },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'a cancel while the stream runs aborts it',
    ),
    c(
      {
        host: { stream: { script: [{ cancel: 'other' }, { observe: 1 }] } },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'a cancel of another request leaves it',
    ),
    c(
      {
        host: { stream: { script: [{ cancel: 1 }, { observe: 1 }] } },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 1, settings: settings() }])],
      },
      'a request id that is a number is not the text of it',
    ),
    c(
      {
        host: { stream: { script: [{ cancel: '1' }, { observe: 1 }] } },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 1, settings: settings() }])],
      },
      'the text of a numeric request id does not cancel it',
    ),
    c(
      {
        host: {
          stream: {
            script: [{ destroy: 1 }, { observe: 1 }, { send: { requestId: 'r1', type: 'text' } }],
          },
        },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'the window goes away mid-stream: aborted, nothing sent to it',
    ),
    c(
      {
        senders: { '1': { destroyed: true } },
        host: { stream: { script: [{ observe: 1 }, { send: { requestId: 'r1', type: 'text' } }] } },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'a window that is already gone: aborted at once',
    ),
    c(
      {
        senders: { '1': { hasOn: false } },
        host: { stream: { script: [{ observe: 1 }] } },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'a sender without the navigation event',
    ),
    c(
      {
        host: {
          stream: {
            script: [{ send: { requestId: 'r1', type: 'text' } }, { throw: 'provider crashed' }],
          },
        },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'a run that throws: the listeners are released and the handler fails',
    ),
    c(
      {
        host: { stream: { script: [{ throw: 'first' }] } },
        steps: [
          { op: 'setup' },
          invoke('ai:stream', [{ requestId: 'r1', settings: settings() }]),
          invoke('ai:stream-cancel', ['r1']),
        ],
      },
      'after the run the request is forgotten',
    ),
  ],
  cancel: [
    c(
      {
        steps: [{ op: 'setup' }, invoke('ai:stream-cancel', ['nope']), invoke('ai:stream-cancel')],
      },
      'nothing is running',
    ),
    c(
      {
        host: { stream: { script: [{ cancel: 'r1', sender: 2 }, { observe: 1 }] } },
        steps: [{ op: 'setup' }, invoke('ai:stream', [{ requestId: 'r1', settings: settings() }])],
      },
      'another window may stop the request by its id',
    ),
  ],
  webSearch: [
    c(
      {
        host: { tools: { webSearchTool: { answer: { results: [1], method: 'serper' } } } },
        steps: [
          { op: 'setup' },
          invoke('ai:web-search', ['cats', 3]),
          invoke('ai:web-search', ['dogs']),
        ],
      },
      'the count defaults to six',
    ),
    c(
      {
        host: { tools: { webSearchTool: { throws: 'search down' } } },
        steps: [{ op: 'setup' }, invoke('ai:web-search', ['cats'])],
      },
      'a failed search answers with the error',
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:web-search', [42, '5']), invoke('ai:web-search')] },
      'the query is a string, the count a number',
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:web-search', [{ toString: 1 }])] },
      'a query that cannot become text',
    ),
  ],
  imageSearch: [
    c(
      {
        host: { tools: { imageSearchTool: { answer: { images: [], method: 'ddg' } } } },
        steps: [
          { op: 'setup' },
          invoke('ai:image-search', ['cats', 3]),
          invoke('ai:image-search', ['dogs']),
        ],
      },
      'the count defaults to eight',
    ),
    c(
      {
        host: { tools: { imageSearchTool: { throws: 'image search down' } } },
        steps: [{ op: 'setup' }, invoke('ai:image-search', ['cats'])],
      },
      'a failed search answers with the error',
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:image-search', [{ toString: 1 }])] },
      'a query that cannot become text',
    ),
  ],
  readUrl: [
    c(
      {
        host: { tools: { readUrlTool: { answer: { ok: true, text: 'page' } } } },
        steps: [
          { op: 'setup' },
          invoke('ai:read-url', ['https://example.com', 40]),
          invoke('ai:read-url', ['https://example.org']),
        ],
      },
      'a page, paged by offset',
    ),
    c(
      {
        host: { tools: { readUrlTool: { throws: 'down' } } },
        steps: [{ op: 'setup' }, invoke('ai:read-url', ['https://example.com'])],
      },
      'a failure answers a network error',
    ),
    c(
      {
        senders: { '1': { destroyed: true } },
        steps: [{ op: 'setup' }, invoke('ai:read-url', ['https://example.com'])],
      },
      'a window that is already gone: the signal is aborted',
    ),
    c(
      { steps: [{ op: 'setup' }, invoke('ai:read-url', [{ toString: 1 }])] },
      'a url that cannot become text',
    ),
  ],
  subscription: [
    c(
      { steps: [{ op: 'setup' }, { op: 'subDep', name: 'getSettings', args: [] }] },
      'the stored settings',
    ),
    c(
      {
        host: { windows: windows2 },
        steps: [
          { op: 'setup' },
          { op: 'subDep', name: 'setMeteredAccepted', args: ['claude', true] },
          { op: 'subDep', name: 'setMeteredAccepted', args: ['codex', false] },
        ],
      },
      '"use anyway" is written and broadcast',
    ),
    c(
      {
        host: { windows: windows2 },
        steps: [
          { op: 'setup' },
          { op: 'subDep', name: 'setMeteredAccepted', args: ['claude', true] },
        ],
      },
      'it goes on top of what the file holds',
      { 'ud/ai-settings.json': storedFile },
    ),
    c(
      {
        host: { uiLang: 'ko' },
        steps: [
          { op: 'setup' },
          { op: 'subDep', name: 'loginWindowText', args: ['claude'] },
          { op: 'subDep', name: 'pages', args: [] },
        ],
      },
      'the texts follow the UI language',
    ),
    c(
      {
        host: { windows: windows2 },
        steps: [
          { op: 'setup' },
          { op: 'subDep', name: 'broadcast', args: ['ai:x'] },
          { op: 'subDep', name: 'broadcast', args: ['ai:y', { a: 1 }] },
        ],
      },
      'a broadcast skips the windows that are gone',
    ),
    c(
      {
        steps: [
          { op: 'setup' },
          { op: 'subDep', name: 'openBrowser', args: ['https://auth.openai.com/x '] },
          { op: 'subDep', name: 'openBrowser', args: ['javascript:alert(1)'] },
          { op: 'subDep', name: 'openBrowser', args: ['not a url'] },
        ],
      },
      'only http(s) pages open',
    ),
    c(
      {
        host: { openExternal: 'reject' },
        steps: [
          { op: 'setup' },
          { op: 'subDep', name: 'openBrowser', args: ['https://auth.openai.com/x'] },
        ],
      },
      'a browser that fails answers false',
    ),
  ],
}

// ---- ai-ipc: the slides-only handlers ----

const PNG = '89504e470d0a1a0a0000'
const JPG = 'ffd8ffe000104a46'
const GIF = '474946383961'
const HTML = Buffer.from('<html></html>').toString('hex')
const b64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64')
const pic = (extra: J = {}): J => ({
  id: 'e1',
  type: 'picture',
  ref: 'durable-1',
  transform: { offset: { cx: 2000000, cy: 1000000 } },
  ...extra,
})
const deckWith = (...elements: J[]): J => [{ ...S1, elements }, S2]

const insertOp = (extra: J = {}): J => ({
  slideIndex: 0,
  url: 'https://img.example/a.png',
  xPx: 10,
  yPx: 20,
  wPx: 200,
  hPx: 100,
  fitWidthPx: 960,
  ...extra,
})
const replaceOp = (extra: J = {}): J => ({
  slideIndex: 0,
  sourceId: 'e1',
  url: 'https://img.example/a.png',
  ...extra,
})
const net = (hex = PNG, extra: J = {}): J => ({ 'https://img.example/a.png': { hex, ...extra } })

const slidesCases = {
  defaultFonts: [
    c(
      { host: { locale: 'ko' }, steps: [invoke('slides:ai-default-fonts')] },
      'no choice stored: the default of the document language',
    ),
    c(
      { host: { locale: 'en' }, steps: [invoke('slides:ai-default-fonts')] },
      'no choice stored, another language',
    ),
    c({ host: { locale: 'ko' }, steps: [invoke('slides:ai-default-fonts')] }, 'a stored choice', {
      'ud/app-settings.json': JSON.stringify({
        slidesAiFonts: { mode: 'serif', sans: 'Gowun Dodum', serif: 'Gowun Batang' },
      }),
    }),
  ],
  toolCapabilities: [
    c({ steps: [invoke('slides:ai-tool-capabilities')] }, 'no settings, nothing connected'),
    c(
      {
        host: {
          statuses: { claude: { state: 'ready' } },
          capabilities: { webSearch: { available: false } },
        },
        steps: [invoke('slides:ai-tool-capabilities')],
      },
      'the stored settings and the connections',
      { 'ud/ai-settings.json': storedFile },
    ),
  ],
  generateImage: [
    c(
      {
        session: { path: `${D}/work/deck.pptx` },
        steps: [
          invoke('ai:generate-image', [
            {
              prompt: 'a cat',
              model: 'm',
              referenceImageUrls: ['a.png', 7],
              aspectRatio: '16:9',
              imageSize: '2K',
              transparentBackground: true,
            },
          ]),
        ],
      },
      'every field of the request, the media roots of the deck',
    ),
    c(
      {
        session: { path: `${D}/work/deck.pptx` },
        steps: [
          invoke('ai:generate-image', [
            { prompt: 5, model: '', transparentBackground: 'yes', referenceImageUrls: 'a.png' },
          ]),
        ],
      },
      'empty and mistyped fields are left out',
    ),
    c(
      {
        session: null,
        host: { statuses: { codex: { state: 'ready' } } },
        steps: [invoke('ai:generate-image', [{ prompt: 'x' }])],
      },
      'a window without a session: only the paste folder',
    ),
    c(
      { session: { path: '' }, steps: [invoke('ai:generate-image', [{ prompt: 'x' }])] },
      'an untitled deck',
    ),
    c(
      {
        steps: [
          invoke('ai:generate-image', [{ prompt: 'x', transparentBackground: false }]),
          invoke('ai:generate-image', [{ prompt: 'x', transparentBackground: true }]),
        ],
      },
      'transparent only when it says true',
    ),
    c(
      {
        host: { tools: { generateImageTool: { throws: 'no route' } } },
        steps: [invoke('ai:generate-image', [{ prompt: 'x' }])],
      },
      'a tool that fails fails the handler',
    ),
    c({ steps: [invoke('ai:generate-image'), invoke('ai:generate-image', [null])] }, 'no request'),
    c(
      {
        senders: { '1': { destroyed: true } },
        steps: [invoke('ai:generate-image', [{ prompt: 'x' }])],
      },
      'a window that is already gone',
    ),
  ],
  analyzeMedia: [
    c(
      {
        session: { path: `${D}/work/deck.pptx` },
        steps: [
          invoke('ai:analyze-media', [{ mediaUrls: ['a.mp4', 3], requirements: 'what is it' }]),
        ],
      },
      'the urls and the requirement as text',
    ),
    c({ steps: [invoke('ai:analyze-media', [{}])] }, 'no urls, no requirement'),
    c(
      { steps: [invoke('ai:analyze-media', [{ mediaUrls: null, requirements: null }])] },
      'null reads as none',
    ),
    c(
      { steps: [invoke('ai:analyze-media', [{ mediaUrls: 'a.mp4' }])] },
      'urls that are not a list',
    ),
    c(
      {
        host: { tools: { analyzeMediaTool: { throws: 'no route' } } },
        steps: [invoke('ai:analyze-media', [{ mediaUrls: [] }])],
      },
      'a tool that fails fails the handler',
    ),
    c({ steps: [invoke('ai:analyze-media')] }, 'no request'),
  ],
  insert: [
    c(
      {
        session: { slides: [S1, S2] },
        host: { net: net(PNG) },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'a download: the frame in EMU, the cover crop of a wider frame',
    ),
    c(
      {
        session: { slides: [S1, S2] },
        host: { net: net(JPG) },
        steps: [invoke('ai:insert-image-url', [insertOp({ wPx: 100 })])],
      },
      'a square frame over a square image: no crop',
    ),
    c(
      {
        session: { slides: [S1, S2] },
        host: { net: net(GIF), native: { [GIF]: { size: { width: 400, height: 100 } } } },
        steps: [invoke('ai:insert-image-url', [insertOp({ wPx: 100 })])],
      },
      'a wide image in a square frame: cropped at the sides',
    ),
    c(
      {
        session: { slides: [S1, S2] },
        host: { net: net(PNG) },
        steps: [
          invoke('ai:insert-image-url', [
            insertOp({ fitWidthPx: 480, xPx: 1, yPx: 1, wPx: 0.00001, hPx: 0.00001 }),
          ]),
        ],
      },
      'the fit width scales the frame; a frame is at least one EMU',
    ),
    c(
      {
        session: { slides: [S1, S2] },
        host: { net: net(PNG) },
        steps: [
          invoke('ai:insert-image-url', [insertOp({ slideIndex: 1 })]),
          invoke('ai:insert-image-url', [insertOp({ slideIndex: 2 })]),
          invoke('ai:insert-image-url', [insertOp({ slideIndex: -1 })]),
          invoke('ai:insert-image-url', [insertOp({ slideIndex: 0.5 })]),
        ],
      },
      'a page that is not there',
    ),
    c(
      {
        session: null,
        steps: [invoke('ai:insert-image-url', [insertOp()]), invoke('ai:insert-image-url')],
      },
      'a window without a session',
    ),
    c({ session: { slides: [S1] }, steps: [invoke('ai:insert-image-url')] }, 'no operation'),
    c(
      { session: { slides: [S1] }, steps: [invoke('ai:insert-image-url', [null])] },
      'a null operation',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(HTML) },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'bytes that are not a raster image',
    ),
    c(
      { session: { slides: [S1] }, steps: [invoke('ai:insert-image-url', [insertOp()])] },
      'no answer from the host',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG, { ok: false }) },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'an answer that is not ok',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG, { tooLarge: true }) },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'a body over the cap',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG) },
        steps: [invoke('ai:insert-image-url', [insertOp({ url: undefined })])],
      },
      'no url',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('ai:insert-image-url', [
            insertOp({ url: undefined, base64: b64(PNG), ext: 'png' }),
          ]),
        ],
      },
      'an attachment: no download',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('ai:insert-image-url', [
            insertOp({ url: undefined, base64: b64(JPG), ext: 'JPEG' }),
          ]),
        ],
      },
      'jpeg is jpg',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('ai:insert-image-url', [
            insertOp({ url: undefined, base64: b64(GIF), ext: 'gif' }),
          ]),
        ],
      },
      'a gif stays',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { native: { [b64hex('webp-bytes')]: { png: 'aabb' } } },
        steps: [
          invoke('ai:insert-image-url', [
            insertOp({
              url: undefined,
              base64: Buffer.from('webp-bytes').toString('base64'),
              ext: 'webp',
            }),
          ]),
        ],
      },
      'anything else becomes PNG',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { native: { [b64hex('bad-bytes')]: { empty: true } } },
        steps: [
          invoke('ai:insert-image-url', [
            insertOp({
              url: undefined,
              base64: Buffer.from('bad-bytes').toString('base64'),
              ext: 'bmp',
            }),
          ]),
        ],
      },
      'bytes the image library cannot read',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('ai:insert-image-url', [insertOp({ url: undefined, base64: '', ext: 'png' })]),
        ],
      },
      'an empty attachment',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [invoke('ai:insert-image-url', [insertOp({ url: undefined, base64: b64(PNG) })])],
      },
      'an attachment without an extension is converted',
    ),
    c(
      {
        session: { slides: [S1] },
        steps: [
          invoke('ai:insert-image-url', [insertOp({ url: undefined, base64: { toString: 1 } })]),
        ],
      },
      'an attachment that cannot become text',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG) },
        steps: [invoke('ai:insert-image-url', [insertOp({ aiRunExpected: true })])],
      },
      'a run is expected and none is open',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG) },
        steps: [invoke('ai:insert-image-url', [insertOp({ aiRunExpected: false })])],
      },
      'no run expected, none open: the write goes on',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG) },
        steps: [
          begin(),
          invoke('ai:insert-image-url', [insertOp({ aiRunExpected: true })]),
          hold(),
        ],
      },
      'a run is expected and open',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG) },
        steps: [
          begin(),
          invoke('ai:insert-image-url', [insertOp({ aiRunExpected: true })], { during: [hold()] }),
        ],
      },
      'the run ended during the download',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG) },
        steps: [
          begin(),
          invoke('ai:insert-image-url', [insertOp({ aiRunExpected: true })], {
            during: [hold(), begin()],
          }),
        ],
      },
      'another run began during the download',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG) },
        steps: [invoke('ai:insert-image-url', [insertOp()], { during: [push] })],
      },
      'no run either way: the write goes on',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG), engine: { addPicture: null } },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'the engine adds nothing: the history step is taken back',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG), engine: { addPicture: 'throw' } },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'the engine throws',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG), engine: { crop: 'throw' } },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'the crop throws: the history step stays',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG), engine: { rebuild: null } },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'the page cannot be rebuilt',
    ),
    c(
      {
        session: { slides: [S1] },
        host: { net: net(PNG), native: { [PNG]: { size: { width: 0, height: 0 } } } },
        steps: [invoke('ai:insert-image-url', [insertOp()])],
      },
      'an image without a size is not cropped',
    ),
  ],
  replace: [
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'the picture is swapped and cover-cropped to its frame',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp({ sourceId: 'durable-1' })])],
      },
      'the durable id is translated to the parse-time id',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp({ sourceId: 'unknown' })])],
      },
      'an id nothing matches goes to the engine as it is',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp({ keepSrcRect: true })])],
      },
      'the crop rectangle is kept: no cover crop',
    ),
    c(
      {
        session: { slides: deckWith(pic({ transform: { offset: { cx: 1000000, cy: 1000000 } } })) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      "a frame of the image's shape: no crop",
    ),
    c(
      {
        session: { slides: deckWith(pic({ transform: {} })) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'a picture without a frame',
    ),
    c(
      {
        session: { slides: deckWith(pic({ type: 'shape' })) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'an element that is not a picture',
    ),
    c(
      {
        session: { slides: deckWith(pic({ transform: { offset: {} } })) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'a frame without a size',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG), engine: { replace: false } },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'the engine replaces nothing: the history step is taken back',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG), engine: { replace: 'throw' } },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'the engine throws',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG), engine: { crop: 'throw' } },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'the crop throws',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG), engine: { rebuild: null } },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'the page cannot be rebuilt',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        steps: [
          invoke('ai:replace-picture-url', [
            replaceOp({ url: undefined, base64: b64(GIF), ext: 'gif' }),
          ]),
        ],
      },
      'an attachment',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(HTML) },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'bytes that are not a raster image',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        steps: [invoke('ai:replace-picture-url', [replaceOp()])],
      },
      'nothing to download',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp({ slideIndex: 4 })])],
      },
      'a page that is not there',
    ),
    c(
      {
        session: null,
        steps: [invoke('ai:replace-picture-url', [replaceOp()]), invoke('ai:replace-picture-url')],
      },
      'a window without a session',
    ),
    c(
      { session: { slides: deckWith(pic()) }, steps: [invoke('ai:replace-picture-url')] },
      'no operation',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp({ aiRunExpected: true })])],
      },
      'a run is expected and none is open',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [
          begin(),
          invoke('ai:replace-picture-url', [replaceOp({ aiRunExpected: true })], {
            during: [hold()],
          }),
        ],
      },
      'the run ended during the download',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [
          begin(),
          invoke('ai:replace-picture-url', [replaceOp({ aiRunExpected: true })]),
          hold(),
        ],
      },
      'inside an open run',
    ),
    c(
      {
        session: { slides: deckWith(pic()) },
        host: { net: net(PNG) },
        steps: [invoke('ai:replace-picture-url', [replaceOp({ sourceId: undefined })])],
      },
      'no source id reads as the word undefined',
    ),
  ],
  sidecar: [
    c(
      {
        session: { path: `${D}/work/deck.pptx` },
        steps: [invoke('ai:save-sidecar', [{ topic: 't', styleSkill: 's', createdAt: 'c' }])],
      },
      'the style beside the draft',
      { 'work/keep.txt': 'x' },
    ),
    c(
      {
        session: { path: `${D}/work/DECK.PPTX` },
        steps: [invoke('ai:save-sidecar', [{ topic: 't' }])],
      },
      'the extension in capitals',
      { 'work/keep.txt': 'x' },
    ),
    c(
      {
        session: { path: `${D}/work/deck.docx` },
        steps: [invoke('ai:save-sidecar', [{ topic: 't' }])],
      },
      'not a pptx',
    ),
    c(
      { session: { path: '' }, steps: [invoke('ai:save-sidecar', [{ topic: 't' }])] },
      'an untitled deck',
    ),
    c({ session: null, steps: [invoke('ai:save-sidecar', [{ topic: 't' }])] }, 'no session'),
    c(
      { session: { path: `${D}/work/deck.pptx` }, steps: [invoke('ai:save-sidecar')] },
      'nothing to write',
      { 'work/keep.txt': 'x' },
    ),
    c(
      { session: { path: `${D}/work/deck.pptx` }, steps: [invoke('ai:save-sidecar', [null])] },
      'null is written',
      { 'work/keep.txt': 'x' },
    ),
    c(
      {
        session: { path: `${D}/missing/deck.pptx` },
        steps: [invoke('ai:save-sidecar', [{ topic: 't' }])],
      },
      'a folder that is not there: fail-open',
    ),
  ],
  sidecarPath: [
    c(
      {
        session: null,
        steps: [
          'a.pptx',
          'dir/My Deck.PPTX',
          'a.pptx.pptx',
          'a.pptx.bak',
          'pptx',
          '.pptx',
          '',
          'a.ppt',
          'x.pptx\n',
          'á.pptx',
        ].map((path) => ({ op: 'sidecar', path })),
      },
      'the path of the sidecar',
    ),
    c(
      { session: null, steps: [{ op: 'sidecar' }, { op: 'sidecar', path: null }] },
      'no draft path',
    ),
  ],
  saveStyle: [
    c(
      {
        steps: [
          invoke('ai:save-style-template', [
            'Corporate',
            { topic: 't', styleSkill: 's', createdAt: 'c', layout: { a: 1 } },
          ]),
        ],
      },
      'the style is written under its name',
    ),
    c(
      { steps: [invoke('ai:save-style-template', ['a/b\\c:d*e?f"g<h>i|j', { topic: 't' }])] },
      'illegal characters become underscores',
    ),
    c(
      { steps: [invoke('ai:save-style-template', ['x'.repeat(70), { topic: 't' }])] },
      'a name is cut to 64',
    ),
    c({ steps: [invoke('ai:save-style-template', ['', { topic: 't' }])] }, 'an empty name'),
    c(
      { steps: [invoke('ai:save-style-template', ['n', { topic: 't', basedOn: '  tpl-1 ' }])] },
      'basedOn is trimmed',
    ),
    c(
      { steps: [invoke('ai:save-style-template', ['n', { topic: 't', basedOn: '   ' }])] },
      'a blank basedOn is left out',
    ),
    c(
      { steps: [invoke('ai:save-style-template', ['n', { topic: 't', basedOn: 7 }])] },
      'a basedOn that is not text is left out',
    ),
    c(
      {
        steps: [
          invoke('ai:save-style-template', ['n', { name: 'mine', topic: 't', basedOn: 'b' }]),
        ],
      },
      'the name key keeps its place',
    ),
    c({ steps: [invoke('ai:save-style-template', ['n', null])] }, 'no data: null'),
    c({ steps: [invoke('ai:save-style-template', ['n'])] }, 'no data'),
    c({ steps: [invoke('ai:save-style-template', ['n', 5])] }, 'data that is a number'),
    c({ steps: [invoke('ai:save-style-template', [5, {}])] }, 'a name that is a number'),
    c({ steps: [invoke('ai:save-style-template', [null, {}])] }, 'a name that is null'),
    c({ steps: [invoke('ai:save-style-template')] }, 'no name'),
    c(
      { steps: [invoke('ai:save-style-template', ['n', { topic: 'new' }])] },
      'an older file of the name is replaced',
      { 'ud/style-templates/n.json': '{"topic":"old"}' },
    ),
  ],
  listStyle: [
    c({ steps: [invoke('ai:list-style-templates')] }, 'no folder'),
    c(
      { steps: [invoke('ai:list-style-templates')] },
      'the saved styles, the damaged ones as their file name',
      {
        'ud/style-templates/b.json': JSON.stringify({
          name: 'B',
          topic: 'tb',
          createdAt: 'cb',
          styleSkill: 's',
        }),
        'ud/style-templates/a.json': JSON.stringify({ topic: 'ta' }),
        'ud/style-templates/broken.json': '{ nope',
        'ud/style-templates/null.json': 'null',
        'ud/style-templates/num.json': '7',
        'ud/style-templates/nulls.json': JSON.stringify({
          name: null,
          topic: null,
          createdAt: null,
        }),
        'ud/style-templates/named.json': JSON.stringify({ name: 0, topic: '', createdAt: false }),
        'ud/style-templates/readme.txt': 'not a style',
        'ud/style-templates/dir.json': { dir: true },
      },
    ),
    c({ steps: [invoke('ai:list-style-templates')] }, 'a folder name that is a file', {
      'ud/style-templates': 'file',
    }),
  ],
  loadStyle: [
    c({ steps: [invoke('ai:load-style-template', ['n'])] }, 'a style that is not there', {}),
    c({ steps: [invoke('ai:load-style-template', ['n'])] }, 'a style without its skill', {
      'ud/style-templates/n.json': '{"topic":"t"}',
    }),
    c({ steps: [invoke('ai:load-style-template', ['n'])] }, 'an empty skill is none', {
      'ud/style-templates/n.json': '{"styleSkill":"","topic":"t"}',
    }),
    c({ steps: [invoke('ai:load-style-template', ['n'])] }, 'a style with layout and basedOn', {
      'ud/style-templates/n.json': JSON.stringify({
        styleSkill: 'skill',
        topic: 't',
        layout: { a: [1] },
        basedOn: ' tpl ',
      }),
    }),
    c(
      { steps: [invoke('ai:load-style-template', ['n'])] },
      'null layout and a blank basedOn are left out; no topic',
      {
        'ud/style-templates/n.json': JSON.stringify({
          styleSkill: 'skill',
          layout: null,
          basedOn: ' ',
        }),
      },
    ),
    c({ steps: [invoke('ai:load-style-template', ['a/b'])] }, 'the name is cleaned as when saved', {
      'ud/style-templates/a_b.json': JSON.stringify({ styleSkill: 'k', topic: 7 }),
    }),
    c({ steps: [invoke('ai:load-style-template', ['n'])] }, 'a file that holds null', {
      'ud/style-templates/n.json': 'null',
    }),
    c({ steps: [invoke('ai:load-style-template', ['n'])] }, 'a damaged file reads as empty', {
      'ud/style-templates/n.json': '{ nope',
    }),
    c({ steps: [invoke('ai:load-style-template', [5])] }, 'a name that is a number'),
    c({ steps: [invoke('ai:load-style-template')] }, 'no name'),
    c({ steps: [invoke('ai:load-style-template', [''])] }, 'an empty name'),
  ],
}

/** the hex of the bytes of a text */
function b64hex(text: string): string {
  return Buffer.from(text).toString('hex')
}

// ---- the pieces of packages/* ----

const direct = (ts: (a: J[]) => unknown, cases: unknown[][], notes: string[] = []): FnSpec => ({
  ts: (a) => ts(a),
  cases: cases.map((args, i) => ({ args, ...(notes[i] ? { note: notes[i] } : {}) })),
})

const next0 = {
  provider: 'openai',
  providers: {
    openai: { apiKey: 'k', model: 'm' },
    kimi: { apiKey: '', model: 'x', extra: 1 },
    bad: 5,
  },
  maxOutputTokens: 100,
}
const stored0 = {
  provider: 'claude',
  providers: {
    openai: { model: 'old', futureField: 1, apiKey: 'zz', cliPath: 'x' },
    kimi: { extra: 9, futureKimi: true },
    other: { x: 1 },
  },
  subscriptionOff: { claude: true },
  futureTop: [1],
  maxOutputTokens: 5,
  constructor: 1,
  toString: 2,
  '2': 'two',
  '10': 'ten',
}

async function keyModelRefresh(): Promise<J> {
  await import('../electron-fake.ts')
  return import('../../../packages/ai-provider/src/key-model-refresh.ts')
}

const providersOf = (models: J, extra: J = {}): J => ({
  provider: 'openai',
  providers: { openai: { apiKey: 'k', model: 'm', ...extra }, ...models },
})

const aiStreamUrl = repoUrl(`${MAIN}ai-stream.ts`)

const proposalSource = (): string => readFileSync(new URL(`${MAIN}ai-proposal.ts`, repo), 'utf8')

export const group: Group = {
  'slides/ai-proposal.AI_REVIEW_SAVE_REASON': {
    ts: () => /AI_REVIEW_SAVE_REASON = '([^']*)'/.exec(proposalSource())?.[1],
    cases: [{ args: [] }],
    single: 'a constant',
  },
  'slides/ai-proposal.beginAiRun': scenario(proposalCases.begin),
  'slides/ai-proposal.holdAiRun': scenario(proposalCases.hold),
  'slides/ai-proposal.acceptAiProposal': scenario(proposalCases.accept),
  'slides/ai-proposal.rejectAiProposal': scenario(proposalCases.reject),
  'slides/ai-proposal.dropAiRunOf': scenario(proposalCases.drop),
  'slides/ai-proposal.markerOf': scenario(proposalCases.marker),
  'slides/ai-proposal.assertNoAiRun': scenario(proposalCases.assert),
  'slides/ai-proposal.trackWrite': scenario(proposalCases.track),
  'slides/ai-proposal.settleWrites': scenario(proposalCases.settle),
  'slides/ai-proposal.registerAiProposalIpc': scenario(proposalCases.ipc),
  'slides/ai-ipc.registerAiIpc': scenario([
    ...aiCases.setup,
    ...aiCases.getSettings,
    ...aiCases.setSettings,
    ...aiCases.logRunFailure,
    ...aiCases.stream,
    ...aiCases.cancel,
    ...aiCases.webSearch,
    ...aiCases.imageSearch,
    ...aiCases.readUrl,
    ...aiCases.subscription,
  ]),
  'slides/ai-ipc.registerSlidesOnlyAiIpc': scenario([
    ...slidesCases.defaultFonts,
    ...slidesCases.toolCapabilities,
    ...slidesCases.generateImage,
    ...slidesCases.analyzeMedia,
    ...slidesCases.insert,
    ...slidesCases.replace,
    ...slidesCases.sidecar,
    ...slidesCases.saveStyle,
    ...slidesCases.listStyle,
    ...slidesCases.loadStyle,
  ]),
  'slides/ai-ipc.styleSkillSidecarPath': scenario(slidesCases.sidecarPath),
  'slides/ai-stream.storedAiSettings': {
    ts: async (a) => (await import(aiStreamUrl)).storedAiSettings(a[0]),
    cases: [
      { args: [{}], note: 'nothing stored' },
      { args: [JSON.parse(storedFile)], note: 'a stored file' },
      {
        args: [{ provider: 'gone', providers: 5, extra: 1 }],
        note: 'a removed selection and unknown fields',
      },
      { args: [null], note: 'null' },
    ],
  },
  'slides/ai-stream.withMeteredAccepted': {
    ts: async (a) => (await import(aiStreamUrl)).withMeteredAccepted(a[0], a[1], a[2]),
    cases: [
      { args: [{ provider: 'auto', providers: {} }, 'claude', true], note: 'a first answer' },
      {
        args: [
          { provider: 'auto', meteredAccepted: { claude: true, codex: true }, other: 1 },
          'codex',
          false,
        ],
        note: 'one of two taken back',
      },
      {
        args: [{ meteredAccepted: { claude: true } }, 'claude', true],
        note: 'the same again keeps its place',
      },
      { args: [{}, '__proto__', true], note: 'a provider named like the prototype' },
    ],
  },
  'pipelines/slides/cover-crop.coverCropFractions': direct(
    (a) => coverCropFractions(a[0], a[1], a[2], a[3]),
    [
      [200, 100, 100, 100],
      [100, 200, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 101],
      [100, 100, 100, 102],
      [0, 100, 100, 100],
      [100, -1, 100, 100],
      [100, 100, 0, 100],
      [100, 100, 100, 0],
      [1000, 10, 50, 50],
      [10, 1000, 50, 50],
      [3, 2, 16, 9],
    ],
    [
      'wide image',
      'tall image',
      'same shape',
      'a one percent difference',
      'beyond one percent',
      'no width',
      'negative height',
      'no frame width',
      'no frame height',
      'very wide',
      'very tall',
      'photo in a slide frame',
    ],
  ),
  'ai-provider/providers.withStoredUnknownFields': direct(
    (a) => withStoredUnknownFields(a[0], a[1]),
    [
      [next0, stored0],
      [next0, {}],
      [next0, null],
      [null, stored0],
      [{ a: 1 }, { providers: { x: 1 }, b: 2 }],
      [{ providers: 5 }, { providers: { x: { y: 1 } }, b: 2 }],
      [{ providers: { openai: [1] } }, { providers: { openai: { z: 1 } } }],
      [['x'], { a: 1 }],
      [{ providers: { openai: { apiKey: 'k' } } }, { providers: { openai: [1] } }],
    ],
    [
      'unknown fields come back, at the top and in the configs',
      'nothing stored',
      'a stored value that is not an object',
      'next is not an object',
      'no providers on next',
      'providers that is not an object',
      'a config that is a list',
      'next is a list',
      'a stored config that is a list',
    ],
  ),
  'ai-provider/providers.withStoredSubscriptionOff': direct(
    (a) => withStoredSubscriptionOff(a[0], a[1]),
    [
      [
        { provider: 'auto', subscriptionOff: { codex: true } },
        { subscriptionOff: { claude: true } },
      ],
      [{ provider: 'auto', subscriptionOff: { codex: true } }, {}],
      [{ provider: 'auto' }, { subscriptionOff: { claude: true } }],
      [{ provider: 'auto' }, {}],
    ],
    [
      'the file decides',
      'a window cannot turn a CLI off',
      'a window cannot turn it back on',
      'neither',
    ],
  ),
  'ai-provider/key-model-refresh.withStoredKeyModels': {
    ts: async (a) => (await keyModelRefresh()).withStoredKeyModels(a[0], a[1]),
    cases: [
      {
        args: [
          providersOf({}, { models: ['sent'] }),
          providersOf({}, { models: ['s1', 's2', 's1', ' ', 5] }),
        ],
        note: 'the stored list, never the sent one',
      },
      {
        args: [providersOf({}), providersOf({}, { models: ['s1'] })],
        note: 'a list the renderer did not send is not lost',
      },
      {
        args: [providersOf({}, { models: ['sent'] }), providersOf({})],
        note: 'none stored: none written',
      },
      {
        args: [
          providersOf(
            {
              custom: {
                apiKey: '',
                model: '',
                modelEfforts: {
                  a: { efforts: ['low', 'high', 'bogus'], defaultEffort: 'high' },
                  b: { efforts: ['bogus'] },
                },
              },
            },
            { modelEfforts: { sent: { efforts: ['max'] } } },
          ),
          providersOf(
            { custom: { modelEfforts: { c: { efforts: ['low'] } } } },
            { modelEfforts: { m: { efforts: ['medium', 'low'], defaultEffort: 'low' } } },
          ),
        ],
        note: 'the custom slot keeps its own table, the others take the stored one',
      },
      {
        args: [
          { provider: 'auto' },
          { provider: 'auto', providers: { openai: { models: ['x'] } } },
        ],
        note: 'no providers',
      },
      {
        args: [
          { provider: 'auto', providers: { openai: null, kimi: { apiKey: '' } } },
          { provider: 'auto' },
        ],
        note: 'a provider that is null',
      },
    ],
  },
  'ai-provider/key-model-refresh.withStoredMainFields': {
    ts: async (a) => (await keyModelRefresh()).withStoredMainFields(a[0], a[1]),
    cases: [
      {
        args: [
          { ...providersOf({}, { models: ['sent'] }), subscriptionOff: { codex: true } },
          { ...providersOf({}, { models: ['s1'] }), subscriptionOff: { claude: true } },
        ],
        note: 'both kinds of fields come from the file',
      },
      { args: [providersOf({}), providersOf({})], note: 'nothing to take' },
    ],
  },
}
