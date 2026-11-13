/**
 * The IPC comparison of stage 3 (the stage 3 shell contract, section 8):
 * every case of every group through the TypeScript handlers (registered on
 * main-diff's fake Electron) and through the Rust handlers (crates/ipc-probe,
 * the shell's own dispatch), each in a fresh folder. A case is equal when
 * each call's answer and events, the host log and the folder after the case
 * are equal, with each side's folder written as `$DIR`. README.md has the
 * shapes.
 *
 *   npm --prefix tools/ipc-diff run gate [-- --group w/quick-look] [--channel name] [--require W] [--show 20] [--list]
 *
 * Without `--group`, each group runs in a process of its own. `--list` prints
 * `group<TAB>channel` for every channel a case calls. `--require <batch>`
 * (repeatable) fails unless every invoke, send and sendSync channel of that
 * batch is called, every one called with arguments gave two distinct
 * answers, and every event channel of the batch was emitted by some case.
 *
 * Fails on a difference that divergences.json does not list, on a listed one
 * that no longer reproduces, on a case either side could not run, and on the
 * coverage of a required batch.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { useElectron } from '../main-diff/electron-fake.ts'
import { Encoder, WireError, decode } from '../../crates/shell/bridge/wire.ts'
import { CHANNELS, SPECS } from './channels.ts'
import { caseElectron } from './fakes.ts'
import { cleanUp, setUp, snapshot, substitute, unsubstitute } from './folder.ts'
import { Probe } from './probe.ts'
import type { Call, Case, Group } from './types.ts'

const tool = dirname(fileURLToPath(import.meta.url))
const root = resolve(tool, '../..')
const out = process.env.IPC_DIFF_OUT ?? join(tool, 'out')
mkdirSync(out, { recursive: true })

interface Divergence {
  id: string
  group: string
  /** the case's index in the group */
  case: number
  typescript: unknown
  rust: unknown
  reason: string
}

/** per channel: how many calls, how many distinct answers, whether any call had arguments */
interface ChannelReport {
  calls: number
  answers: string[]
  withArgs: boolean
}
interface GroupReport {
  batch: string
  channels: Record<string, ChannelReport>
  /** the event channels some call emitted, on the TypeScript side */
  events: string[]
  single: Record<string, string>
}

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const args = (flag: string): string[] =>
  process.argv.flatMap((a, i) => (a === flag ? [process.argv[i + 1]] : []))
const show = Number(arg('--show') ?? 10)

/** `<batch>/<file>` for every groups/<batch>/<file>.ts */
function groupNames(): string[] {
  const root = join(tool, 'groups')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(root, d.name))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => `${d.name}/${f.slice(0, -3)}`),
    )
    .sort()
}

async function loadGroup(name: string): Promise<Group> {
  const mod = (await import(pathToFileURL(join(tool, 'groups', `${name}.ts`)).href)) as {
    group: Group
  }
  return mod.group
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const noHandler = (channel: string): string => `Error: No handler registered for '${channel}'`
const remote = (channel: string, text: string): string =>
  `Error invoking remote method '${channel}': ${text}`

/** what the shell's dispatch refuses before any handler runs (crates/shell-core/src/dispatch.rs) */
function refusal(call: Call, surface: string): string | undefined {
  const spec = SPECS.get(call.channel)
  if (!spec) return noHandler(call.channel)
  if (!spec.surfaces.includes(surface)) return `Error: '${call.channel}' is not open to ${surface}`
  return undefined
}

let freshCount = 0

/** The TypeScript side of one case: `{calls: [{answer, events}], log}` */
async function typescriptSide(group: Group, c: Case, dir: string): Promise<unknown> {
  const electron = caseElectron(dir, c)
  useElectron(electron)
  await group.load({
    dir,
    case: c,
    electron,
    // a query makes a module instance of its own: the module is chosen per case
    fresh: (path) => import(`${pathToFileURL(resolve(root, path)).href}?case=${freshCount++}`),
  })
  const views = c.views ?? [{ view: 1, window: 1, surface: 'Shell' }]
  const calls = []
  for (const call of c.calls) {
    const kind = call.kind ?? 'invoke'
    const view = views.find((v) => v.view === (call.view ?? views[0].view))
    if (!view) throw new Error(`no view ${call.view}`)
    const values = decode(
      call.args,
      (call.buffers ?? []).map((b) => Buffer.from(b, 'hex')),
    ) as unknown[]
    const sender = electron.contents(view.view)
    const event: Record<string, unknown> = {
      sender,
      senderFrame: { url: 'app://seuoffice/' },
      processId: 1,
      frameId: 1,
      reply: (ch: string, ...a: unknown[]) => sender.send(ch, ...a),
    }
    const refused = refusal(call, view.surface ?? 'Shell')
    let answer: Record<string, unknown>
    if (kind === 'send') {
      const listeners = electron.handlers.on.get(call.channel) ?? []
      answer = {}
      if (refused !== undefined) answer = { thrown: refused }
      else if (listeners.length === 0) answer = { thrown: noHandler(call.channel) }
      for (const fn of refused === undefined ? listeners : []) {
        try {
          await fn(event, ...values)
        } catch (err) {
          answer = { thrown: String(err) }
        }
      }
    } else {
      try {
        if (refused !== undefined) throw { shell: refused }
        let value: unknown
        if (kind === 'invoke') {
          const fn = electron.handlers.invoke.get(call.channel)
          if (!fn) throw { shell: noHandler(call.channel) }
          value = await fn(event, ...values)
        } else {
          const fn = electron.handlers.on.get(call.channel)?.[0]
          if (!fn) throw { shell: noHandler(call.channel) }
          await fn(event, ...values)
          value = event.returnValue
        }
        const e = new Encoder()
        try {
          answer = { value: e.value(value), buffers: e.buffers.map(hex) }
        } catch (err) {
          if (!(err instanceof WireError)) throw err
          throw new Error('An object could not be cloned.')
        }
      } catch (err) {
        const text = (err as { shell?: string } | null)?.shell ?? String(err)
        answer = { error: remote(call.channel, text) }
      }
    }
    await settle()
    calls.push({ answer, events: electron.takeEvents() })
  }
  return { calls, log: electron.log }
}

/** One side of one case in a fresh folder: the record and the folder after, as JSON with `$DIR` */
async function side(c: Case, run: (c: Case, dir: string) => Promise<unknown>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'ipc-diff-'))
  try {
    setUp(dir, c.files)
    const record = await run(substitute(c, dir), dir)
    const text = unsubstitute(JSON.stringify({ record, files: snapshot(dir) }), dir)
    // the temporary file of an atomic write is named after the process and a
    // random UUID (app-settings.ts, main-core's app_settings): never the same twice
    return text.replace(
      /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp/g,
      '.$PID.$UUID.tmp',
    )
  } finally {
    cleanUp(dir)
  }
}

async function runGroup(name: string): Promise<void> {
  const group = await loadGroup(name)
  const only = args('--channel')
  const ledger: Divergence[] = JSON.parse(readFileSync(join(tool, 'divergences.json'), 'utf8'))
  const probe = new Probe()
  const report: GroupReport = {
    batch: group.batch,
    channels: {},
    events: [],
    single: group.single ?? {},
  }
  const events = new Set<string>()
  const differences: { case: number; note?: string; typescript: string; rust: string }[] = []
  const reproduced = new Set<string>()
  let bad = 0
  let equal = 0
  let checked = 0

  for (const [i, c] of group.cases.entries()) {
    if (only.length > 0 && !c.calls.some((call) => only.includes(call.channel))) continue
    checked++
    const ts = await side(c, (cc, dir) =>
      typescriptSide(group, cc, dir).catch((err: unknown) => ({
        bad: String((err as Error)?.stack ?? err),
      })),
    )
    const rust = await side(c, async (cc, dir) => {
      const line = JSON.parse(await probe.run(dir, cc)) as Record<string, unknown>
      // the TypeScript's JSON.stringify writes numbers as JavaScript does
      return 'calls' in line ? { calls: line.calls, log: line.log } : line
    })
    const tsRecord = JSON.parse(ts).record as {
      calls?: { answer: unknown; events: { channel: string }[] }[]
    }
    if (!tsRecord.calls || !('calls' in JSON.parse(rust).record)) {
      bad++
      differences.push({ case: i, note: `BAD ${c.note ?? ''}`, typescript: ts, rust })
      continue
    }
    for (const [k, call] of c.calls.entries()) {
      const r = (report.channels[call.channel] ??= { calls: 0, answers: [], withArgs: false })
      r.calls++
      r.withArgs ||= call.args.length > 0
      const answer = JSON.stringify(tsRecord.calls[k]?.answer)
      if (!r.answers.includes(answer)) r.answers.push(answer)
      for (const e of tsRecord.calls[k]?.events ?? []) events.add(e.channel)
    }
    if (ts === rust) {
      equal++
      continue
    }
    const entry = ledger.find((d) => d.group === name && d.case === i)
    if (entry && JSON.stringify(entry.typescript) === ts && JSON.stringify(entry.rust) === rust) {
      reproduced.add(entry.id)
      continue
    }
    differences.push({ case: i, note: c.note, typescript: ts, rust })
  }
  probe.close()
  report.events = [...events].sort()
  writeFileSync(join(out, 'report.json'), JSON.stringify({ report, differences }, null, 2))

  const cut = (text: string): string =>
    text.length <= 4000 ? text : `${text.slice(0, 4000)}... (${text.length} characters)`
  for (const d of differences.slice(0, show)) {
    console.log(`\nDIFF ${name} case ${d.case}${d.note ? ` (${d.note})` : ''}`)
    console.log(`  typescript: ${cut(d.typescript)}`)
    console.log(`  rust:       ${cut(d.rust)}`)
  }
  const stale =
    only.length > 0 ? [] : ledger.filter((d) => d.group === name && !reproduced.has(d.id))
  for (const d of stale) console.log(`STALE ledger entry ${d.id}: it no longer reproduces`)
  console.log(
    `${name}: ${checked} cases, ${equal} equal, ${differences.length - bad} differences, ${reproduced.size} listed, ${bad} bad`,
  )
  process.exitCode = differences.length > 0 || stale.length > 0 ? 1 : 0
}

/** Coverage of a required batch over every group's report */
function coverage(batch: string, reports: GroupReport[]): string[] {
  const merged = new Map<string, ChannelReport>()
  const emitted = new Set<string>()
  const single = new Map<string, string>()
  for (const r of reports) {
    for (const [ch, c] of Object.entries(r.channels)) {
      const m = merged.get(ch) ?? { calls: 0, answers: [], withArgs: false }
      m.calls += c.calls
      m.withArgs ||= c.withArgs
      for (const a of c.answers) if (!m.answers.includes(a)) m.answers.push(a)
      merged.set(ch, m)
    }
    for (const e of r.events) emitted.add(e)
    for (const [ch, why] of Object.entries(r.single)) single.set(ch, why)
  }
  const problems: string[] = []
  for (const spec of CHANNELS.filter((s) => s.batch === batch)) {
    const handled = spec.kinds.some((k) => k === 'invoke' || k === 'send' || k === 'sendSync')
    const c = merged.get(spec.name)
    if (handled && !c) problems.push(`${spec.name}: no case calls it`)
    else if (handled && c && c.withArgs && c.answers.length < 2 && !single.has(spec.name))
      problems.push(`${spec.name}: fewer than two distinct answers`)
    if (spec.kinds.includes('event') && !emitted.has(spec.name))
      problems.push(`${spec.name}: no case emits this event`)
  }
  return problems
}

function runEveryGroup(): void {
  let failed = false
  const reports: Record<string, GroupReport> = {}
  for (const name of groupNames()) {
    const groupOut = join(out, ...name.split('/'))
    const run = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
        '--group',
        name,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, IPC_DIFF_OUT: groupOut },
        maxBuffer: 1 << 30,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    process.stdout.write(run.stdout)
    if (run.status !== 0) failed = true
    if (existsSync(join(groupOut, 'report.json'))) {
      reports[name] = JSON.parse(readFileSync(join(groupOut, 'report.json'), 'utf8')).report
    } else if (!process.argv.includes('--list')) {
      console.log(`GROUP ${name} did not finish (${run.status ?? run.signal})`)
    }
  }
  if (process.argv.includes('--list')) return
  writeFileSync(join(out, 'report.json'), JSON.stringify(reports, null, 2))
  for (const batch of args('--require')) {
    const problems = coverage(
      batch,
      Object.values(reports).filter((r) => r.batch === batch),
    )
    for (const p of problems) console.log(`COVERAGE ${batch} ${p}`)
    console.log(`coverage of ${batch}: ${problems.length} problems`)
    if (problems.length > 0) failed = true
  }
  process.exitCode = failed ? 1 : 0
}

const only = arg('--group')
if (only === undefined) runEveryGroup()
else if (!groupNames().includes(only)) {
  console.log(`no such group: ${only}`)
  process.exitCode = 1
} else if (process.argv.includes('--list')) {
  const group = await loadGroup(only)
  const seen = new Set(group.cases.flatMap((c) => c.calls.map((call) => call.channel)))
  for (const channel of [...seen].sort()) console.log(`${only}\t${channel}`)
} else await runGroup(only)
