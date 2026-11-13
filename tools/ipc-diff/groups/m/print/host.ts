/**
 * The hosts of batch M's print groups on the TypeScript side: what
 * crates/shell-ipc/m/src/probe.rs fakes for the Rust side (hidden print
 * windows, `/usr/bin/lp` and `/usr/bin/lpoptions`, the printer list, the temp
 * folder), answering from the same `hosts.m` keys with the same defaults and
 * logging the same lines. It lives in a folder of its own because every file
 * of `groups/m` is a group.
 *
 * Platform: nothing is faked. The Rust side takes `std::env::consts::OS` as
 * Node names it, and `process.platform` here is that very value, so the CUPS
 * branches run on macOS and the other branch on the Linux runner. A case
 * therefore compares whichever branch its machine takes.
 */
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { basename, join } from 'node:path'
import { takePrintDocument } from '../../../../../apps/diagram/src/main/print-document.ts'
import { useElectron } from '../../../../main-diff/electron-fake.ts'
import type { LoadContext } from '../../../types.ts'

/** the keys of `hosts.m` that probe.rs reads for the print hosts and the groups read for their own */
export interface Config {
  printers?: { name?: string; displayName?: string }[]
  print?: { success?: boolean; failureReason?: string }
  pdf?: string
  pdfError?: string | null
  loadError?: string | null
  exec?: 'settled' | 'pending' | 'rejected'
  commands?: Record<string, { code?: number | null; stdout?: string; stderr?: string }>
  appLocale?: string
  envLang?: string | null
  headless?: boolean
  openGenerated?: boolean
  defaultSaveDir?: string
}

/** the case's `hosts.m` */
export const hostConfig = (cx: LoadContext): Config => ((cx.case.hosts ?? {}).m ?? {}) as Config

// captured when this module loads, before any case patches them: the
// harness itself still needs the real ones between cases
const realTmpdir = os.tmpdir
const realSpawn = childProcess.spawn
const realExecFile = childProcess.execFile
const realSetTimeout = globalThis.setTimeout
let shrinkReadyTimer = false

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null))

/** `Printer`s of probe.rs: `name`, `displayName`, and `office`/`Office` when the case names none */
function printersOf(config: Config): { name: string; displayName: string }[] {
  if (!Array.isArray(config.printers)) return [{ name: 'office', displayName: 'Office' }]
  return config.printers.map((p) => ({ name: p.name ?? '', displayName: p.displayName ?? '' }))
}

/** `Fake::run_command` of probe.rs: the case's `commands[file]`, else the process does not start */
function command(cx: LoadContext, file: string, args: unknown, stdinLength: number) {
  cx.electron.log.push(['execFile', file, args, stdinLength])
  return (hostConfig(cx).commands ?? {})[file]
}

/** The profile probe.rs's `PrintProfile` names for the web preferences a window was made with */
function profileOf(options: unknown): string {
  const prefs = (options as { webPreferences?: Record<string, unknown> } | undefined)?.webPreferences ?? {}
  if (prefs.javascript === false) return 'static'
  if (prefs.partition !== undefined) return 'diagram'
  if (prefs.session !== undefined) return 'mindmap-export'
  return 'scripted'
}

/**
 * Installs the hosts on the case's Electron, Node's `os` and `child_process`,
 * and makes the modules loaded next see them. Call it before loading anything.
 */
export function installPrintHosts(cx: LoadContext): void {
  const config = hostConfig(cx)
  const log = cx.electron.log

  // the folder `app.getPath('temp')` is for the Rust side: temp folders of a
  // print land there. Outside a case (the harness makes its folders between
  // cases, after the case's own is gone) the real one answers.
  const temp = join(cx.dir, 'temp')
  os.tmpdir = () => (existsSync(temp) ? temp : realTmpdir())

  // the `lp` and `lpoptions` of CUPS; any other command is the harness's own
  ;(childProcess as { spawn: unknown }).spawn = (file: string, args: string[], ...rest: unknown[]) => {
    if (file !== '/usr/bin/lp') return (realSpawn as (...a: unknown[]) => unknown)(file, args, ...rest)
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = Object.assign(new EventEmitter(), {
      end(data: Uint8Array) {
        const out = command(cx, file, args, data.length)
        setImmediate(() => {
          if (!out) {
            child.emit('error', new Error(`spawn ${file} ENOENT`))
            return
          }
          if (out.stdout) (child.stdout as EventEmitter).emit('data', out.stdout)
          if (out.stderr) (child.stderr as EventEmitter).emit('data', out.stderr)
          child.emit('close', out.code ?? null)
        })
      },
    })
    return child
  }
  ;(childProcess as { execFile: unknown }).execFile = (
    file: string,
    args: string[],
    callback: (err: Error | null, stdout: string, stderr: string) => void,
    ...rest: unknown[]
  ) => {
    if (file !== '/usr/bin/lpoptions') {
      return (realExecFile as (...a: unknown[]) => unknown)(file, args, callback, ...rest)
    }
    const out = command(cx, file, args, 0)
    setImmediate(() => {
      if (!out) callback(new Error(`spawn ${file} ENOENT`), '', '')
      else if (out.code !== 0) callback(new Error('Command failed'), out.stdout ?? '', out.stderr ?? '')
      else callback(null, out.stdout ?? '', out.stderr ?? '')
    })
    return undefined
  }
  syncBuiltinESMExports()

  // the readiness probe of a document that never settles races a 5 s timer:
  // the Rust side is told the timer fired, this one is made to fire at once
  shrinkReadyTimer = config.exec === 'pending'
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) =>
    realSetTimeout(fn, shrinkReadyTimer && ms === 5_000 ? 0 : ms, ...args)) as typeof setTimeout

  // `webContents.getPrintersAsync` of every sender
  for (const view of (cx.case.views ?? [{ view: 1 }]).map((v) => v.view)) {
    cx.electron.contents(view).getPrintersAsync = async () => printersOf(config)
  }

  // `new BrowserWindow(options)`: the hidden print windows of probe.rs's FakeSurface
  const Real = cx.electron.BrowserWindow as Record<string, unknown>
  class PrintWindow {
    destroyed = false
    readonly webContents = {
      executeJavaScript: (_script: string, _gesture?: boolean): Promise<unknown> => {
        log.push(['win.webContents.executeJavaScript'])
        if (config.exec === 'pending') return new Promise(() => {})
        if (config.exec === 'rejected') return Promise.reject(new Error('probe failed'))
        return Promise.resolve()
      },
      print: (
        options: unknown,
        callback: (success: boolean, failureReason: string) => void,
      ): void => {
        log.push(['win.webContents.print', plain(options)])
        callback(config.print?.success ?? true, config.print?.failureReason ?? '')
      },
      printToPDF: async (options: unknown): Promise<Buffer> => {
        log.push(['win.webContents.printToPDF', plain(options)])
        if (typeof config.pdfError === 'string') throw new Error(config.pdfError)
        return Buffer.from(config.pdf ?? '%PDF-fake', 'utf8')
      },
      // the diagram window's navigation guard: Electron's own, not logged
      setWindowOpenHandler: (): void => {},
      on: (): void => {},
      getURL: (): string => '',
    }

    constructor(options: unknown) {
      log.push(['new BrowserWindow', profileOf(options)])
    }

    private loaded(): Promise<void> {
      return typeof config.loadError === 'string'
        ? Promise.reject(new Error(config.loadError))
        : Promise.resolve()
    }

    loadFile(path: string): Promise<void> {
      log.push(['win.loadFile', basename(path), existsSync(path) ? readFileSync(path, 'utf8') : ''])
      return this.loaded()
    }

    // the token at the end of the address is random
    loadURL(url: string): Promise<void> {
      const cut = url.lastIndexOf('/')
      const token = cut >= 0 ? url.slice(cut + 1) : ''
      log.push(['win.loadURL', cut >= 0 ? url.slice(0, cut) : url, takePrintDocument(token)])
      return this.loaded()
    }

    show(): void {
      log.push(['win.show'])
    }

    focus(): void {
      log.push(['win.focus'])
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    destroy(): void {
      log.push(['win.destroy'])
      this.destroyed = true
    }
  }
  Object.assign(PrintWindow, Real)
  Object.assign(cx.electron, {
    BrowserWindow: PrintWindow,
    // mindmap's export session: a partition whose request blocker nobody calls
    session: { fromPartition: () => ({ webRequest: { onBeforeRequest: () => {} } }) },
  })
  // `useElectron` copied the fake's names before the group added these
  useElectron(cx.electron)
}
