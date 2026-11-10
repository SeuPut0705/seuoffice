/**
 * The shell around the reducer: it turns link, adapter and timer callbacks
 * into events, runs one event at a time, and carries out the effects. Adapter
 * exceptions, and an `emit` from inside `integrate`, become `adapter_failed`.
 */

import { systemClock, type Clock } from '../clock.js'
import { deferred, type Deferred } from '../deferred.js'
import type { Json } from '../model.js'
import { sha256 } from '../sha256.js'
import { parseServerFrame } from '../wire.js'
import {
  CollabError,
  type CollabAdapter,
  type CollabFile,
  type CollabJoin,
  type CollabLink,
  type CollabLinkEvent,
  type CollabOptions,
  type CollabSession,
  type CollabStatus,
  type SavedVersion,
} from './api.js'
import {
  initialState,
  reduce,
  statusOf,
  type EngineEffect,
  type EngineEvent,
  type EngineState,
  type ProducedFile,
  type Purpose,
  type Step,
  type TimerName,
} from './engine.js'

export interface Engine {
  join: Promise<CollabJoin>
  /** resolves once no hash, fingerprint or file the engine waits for is outstanding */
  settled(): Promise<void>
}

export function joinCollab(
  link: CollabLink,
  file: CollabFile,
  options: CollabOptions = {},
): Promise<CollabJoin> {
  return startEngine(link, file, systemClock, options).join
}

const SAVE_TIMEOUT_MS = 30_000

/** The engine's state holds adapter ops it never looks into */
type Op = unknown

export function startEngine(
  link: CollabLink,
  file: CollabFile,
  clock: Clock,
  options: CollabOptions = {},
): Engine {
  let state: EngineState<Op> | null = null
  let adapter: CollabAdapter<Op> | null = null
  let integrating = false
  let emittedWhileIntegrating = false
  let draining = false
  const queue: EngineEvent<Op>[] = []
  const timers = new Map<TimerName, unknown>()
  const outstanding = new Set<Promise<unknown>>()
  const statusHandlers = new Set<(status: CollabStatus) => void>()
  let lastStatus = ''
  let save: Deferred<SavedVersion> | null = null
  let exporting: Deferred<ProducedFile> | null = null
  let unlisten: (() => void) | null = null
  let unsubscribe: (() => void) | null = null
  const joined = deferred<CollabJoin>()

  function track(promise: Promise<unknown>): void {
    const settled = promise.then(
      () => {},
      () => {},
    )
    outstanding.add(settled)
    void settled.then(() => outstanding.delete(settled))
  }

  function dispatch(event: EngineEvent<Op>): void {
    queue.push(event)
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) step(queue.shift()!)
    } finally {
      draining = false
    }
    if (!adapter || !state) return
    const status = statusOf(state)
    const text = JSON.stringify(status)
    if (text === lastStatus) return
    lastStatus = text
    for (const handler of statusHandlers) handler(status)
  }

  function step(event: EngineEvent<Op>): void {
    const env = { now: clock.now(), encode: (op: Op) => adapter!.encode(op) }
    let result: Step<Op>
    try {
      result = reduce(state!, event, env)
    } catch {
      result = reduce(state!, { type: 'adapter_failed' }, env)
    }
    state = result.state
    for (const effect of result.effects) perform(effect)
  }

  /** An adapter call that failed; handled before any other queued event */
  function adapterFailed(): void {
    queue.unshift({ type: 'adapter_failed' })
  }

  function guard(call: () => void): void {
    try {
      call()
    } catch {
      adapterFailed()
    }
  }

  function perform(effect: EngineEffect<Op>): void {
    switch (effect.type) {
      case 'open':
        return link.open()
      case 'close':
        return link.close()
      case 'send':
        return link.send(JSON.stringify(effect.frame))
      case 'send_file':
        return link.send(file.bytes)
      case 'timer': {
        clock.clearTimeout(timers.get(effect.name))
        const name = effect.name
        const handle = clock.setTimeout(() => {
          timers.delete(name)
          dispatch({ type: 'timer', name })
        }, effect.delay)
        timers.set(name, handle)
        return
      }
      case 'then':
        queue.push(effect.event)
        return
      case 'cancel_timers':
        for (const handle of timers.values()) clock.clearTimeout(handle)
        timers.clear()
        return
      case 'joined':
        return joined.resolve({ baseBytes: effect.baseBytes ?? file.bytes, attach })
      case 'join_failed':
        return joined.reject(new CollabError(effect.code, detail()))
      case 'editable':
        if (adapter) guard(() => adapter!.setEditable(effect.value))
        return
      case 'integrate':
        return integrate(effect.remote, effect.local)
      case 'confirmed':
        return guard(() => adapter!.confirmed?.(effect.ops))
      case 'fingerprint':
        return fingerprint(effect.v)
      case 'produce':
        return produce(effect.purpose)
      case 'save_done':
        save?.resolve({ ...effect.file, version: effect.version })
        save = null
        return
      case 'save_failed':
        save?.reject(new CollabError(effect.code, detail()))
        save = null
        return
      case 'export_done':
        exporting?.resolve(effect.file)
        exporting = null
        return
      case 'export_failed':
        exporting?.reject(new CollabError(effect.code))
        exporting = null
        return
    }
  }

  function integrate(remote: Json[][], local: Op[]): void {
    const editor = adapter!
    integrating = true
    emittedWhileIntegrating = false
    let rewritten: Op[] | null = local
    try {
      for (const ops of remote)
        rewritten = editor.integrate(
          ops.map((op) => editor.decode(op)),
          rewritten,
        )
    } catch {
      rewritten = null
    } finally {
      integrating = false
    }
    if (rewritten === null || emittedWhileIntegrating) adapterFailed()
    else queue.unshift({ type: 'integrated', local: rewritten })
  }

  function fingerprint(v: number): void {
    let value: string | Promise<string>
    try {
      value = adapter!.fingerprint()
    } catch {
      return adapterFailed()
    }
    track(
      Promise.resolve(value).then(
        (fp) => dispatch({ type: 'fingerprinted', v, fp }),
        () => dispatch({ type: 'adapter_failed' }),
      ),
    )
  }

  function detail(): string | undefined {
    return state?.detail ?? undefined
  }

  /** a failed save is rejected by the session failing; a failed export only by its own promise */
  function produceFailed(purpose: Purpose): void {
    if (purpose === 'export') {
      exporting?.reject(new CollabError('adapter'))
      exporting = null
    }
  }

  function produce(purpose: Purpose): void {
    let file: Promise<ProducedFile>
    try {
      file = adapter!.produceFile()
    } catch {
      produceFailed(purpose)
      return adapterFailed()
    }
    track(
      Promise.resolve(file).then(
        (produced) => dispatch({ type: 'produced', purpose, file: produced }),
        () => {
          produceFailed(purpose)
          dispatch({ type: 'adapter_failed' })
        },
      ),
    )
  }

  const session: CollabSession = {
    save() {
      if (save) return save.promise
      save = deferred<SavedVersion>()
      const pending = save.promise
      dispatch({ type: 'save' })
      return pending
    },
    exportLocal() {
      if (exporting) return exporting.promise
      exporting = deferred<ProducedFile>()
      const pending = exporting.promise
      dispatch({ type: 'export' })
      return pending
    },
    reportSaved(version) {
      dispatch({ type: 'report_saved', v: version })
    },
    status() {
      return statusOf(state!)
    },
    subscribe(handler) {
      statusHandlers.add(handler)
      return () => statusHandlers.delete(handler)
    },
    close() {
      dispatch({ type: 'shutdown' })
      unlisten?.()
      unsubscribe?.()
    },
  }

  function attach<A>(editor: CollabAdapter<A>): CollabSession {
    if (adapter) throw new Error('attach is allowed once per join')
    adapter = editor as CollabAdapter<Op>
    try {
      unlisten = editor.listen((ops) => {
        if (integrating) emittedWhileIntegrating = true
        else dispatch({ type: 'local', ops: ops.slice() })
      })
    } catch {
      dispatch({ type: 'adapter_failed' })
    }
    dispatch({ type: 'attach' })
    return session
  }

  function onLink(event: CollabLinkEvent): void {
    if (event.type !== 'frame') return dispatch(event)
    let frame
    try {
      frame = parseServerFrame(event.frame)
    } catch {
      return dispatch({ type: 'bad_frame' })
    }
    dispatch({ type: 'frame', frame })
  }

  track(
    sha256(file.bytes).then(
      (hash) => {
        state = initialState(file.format, hash, options.saveTimeoutMs ?? SAVE_TIMEOUT_MS)
        unsubscribe = link.subscribe(onLink)
        link.open()
      },
      (error: unknown) => joined.reject(error),
    ),
  )

  return {
    join: joined.promise,
    async settled() {
      while (outstanding.size > 0) await Promise.all(outstanding)
    },
  }
}
