// Measures one call from the main process into Rust and back, both ways, by
// Node-API and by a sidecar process. Run it after `cargo build --release`:
//   node crates/spike-main-bridge/bench.mjs [rounds]
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron crates/spike-main-bridge/bench.mjs
// The two bridges alternate within each round, so drift of the machine falls
// on both. Each figure is the median of the rounds' medians.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const release = join(here, 'target', 'release')
const libName = { darwin: 'libspike_main_bridge.dylib', linux: 'libspike_main_bridge.so', win32: 'spike_main_bridge.dll' }[process.platform]
const addonPath = join(release, 'spike_main_bridge.node')
copyFileSync(join(release, libName), addonPath)
const sidecarPath = join(release, process.platform === 'win32' ? 'sidecar.exe' : 'sidecar')
if (!existsSync(sidecarPath)) throw new Error('build the sidecar first')

const rounds = Number(process.argv[2] ?? 5)
const SMALL_CALLS = 20_000
const BIG_CALLS = 200
const PINGS = 5_000

// a settings file of about 1 KB, the size of app-settings.json on a used install
const settings = {
  uiLanguage: 'ko',
  onboardingDone: true,
  windowBounds: { x: 120, y: 80, width: 1360, height: 900, maximized: false },
  splitView: { orientation: 'side', ratio: 0.5, focus: 'a' },
  folderRoots: ['/Users/someone/Documents', '/Users/someone/Desktop'],
  projects: {
    installId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    list: Array.from({ length: 6 }, (_, i) => ({
      id: `0f8fad5b-d9cb-469f-a165-7086772895${String(i).padStart(2, '0')}`,
      path: `/Users/someone/Projects/p${i}`,
      pinned: i === 0,
      lastUsedAt: '2026-11-12T10:00:00.000Z',
    })),
  },
}
const smallArgs = JSON.stringify(settings)
const big = Buffer.alloc(1 << 20, 7)

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const p99 = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.99)]
}
const now = () => Number(process.hrtime.bigint()) / 1000

// ---- Node-API ----
const loadStart = now()
const require = createRequire(import.meta.url)
const addon = require(addonPath)
const napiLoadUs = now() - loadStart

function napiSmall() {
  const t = []
  for (let i = 0; i < SMALL_CALLS; i++) {
    const s = now()
    JSON.parse(addon.call('readAppSettings', smallArgs))
    t.push(now() - s)
  }
  return t
}
function napiBig() {
  const t = []
  for (let i = 0; i < BIG_CALLS; i++) {
    const s = now()
    addon.callBytes(big)
    t.push(now() - s)
  }
  return t
}
async function napiPings() {
  return addon.pings((err, i) => i + 1, PINGS)
}

// ---- sidecar ----
class Sidecar {
  constructor() {
    this.child = spawn(sidecarPath, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.buf = Buffer.alloc(0)
    this.waiting = []
    this.onAsk = null
    this.child.stdout.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      for (;;) {
        if (this.buf.length < 4) return
        const len = this.buf.readUInt32LE(0)
        if (this.buf.length < 4 + len) return
        const kind = this.buf[4]
        const payload = this.buf.subarray(5, 4 + len)
        this.buf = this.buf.subarray(4 + len)
        if (kind === 4) this.send(5, Buffer.from([payload[0] + 1]))
        else this.waiting.shift()(payload)
      }
    })
  }
  send(kind, payload) {
    const head = Buffer.alloc(5)
    head.writeUInt32LE(payload.length + 1, 0)
    head[4] = kind
    this.child.stdin.write(Buffer.concat([head, payload]))
  }
  request(kind, payload) {
    return new Promise((resolve) => {
      this.waiting.push(resolve)
      this.send(kind, payload)
    })
  }
  close() {
    this.child.stdin.end()
  }
}

const spawnStart = now()
const sidecar = new Sidecar()
await sidecar.request(1, Buffer.from(JSON.stringify({ name: 'hello', args: null })))
const sidecarFirstReplyUs = now() - spawnStart

async function sidecarSmall() {
  const t = []
  const body = Buffer.from(`{"name":"readAppSettings","args":${smallArgs}}`)
  for (let i = 0; i < SMALL_CALLS / 10; i++) {
    const s = now()
    JSON.parse((await sidecar.request(1, body)).toString('utf8'))
    t.push(now() - s)
  }
  return t
}
async function sidecarBig() {
  const t = []
  for (let i = 0; i < BIG_CALLS; i++) {
    const s = now()
    await sidecar.request(2, big)
    t.push(now() - s)
  }
  return t
}
async function sidecarPings() {
  return JSON.parse((await sidecar.request(3, Buffer.from(String(PINGS)))).toString('utf8'))
}

const results = { napi: { small: [], big: [], pings: [] }, sidecar: { small: [], big: [], pings: [] } }
for (let r = 0; r < rounds; r++) {
  const order = r % 2 === 0 ? ['napi', 'sidecar'] : ['sidecar', 'napi']
  for (const which of order) {
    if (which === 'napi') {
      results.napi.small.push(median(napiSmall()))
      results.napi.big.push(median(napiBig()))
      const p = await napiPings()
      results.napi.pings.push(median(p))
      results.napi.pingsP99 = p99(p)
    } else {
      results.sidecar.small.push(median(await sidecarSmall()))
      results.sidecar.big.push(median(await sidecarBig()))
      const p = await sidecarPings()
      results.sidecar.pings.push(median(p))
      results.sidecar.pingsP99 = p99(p)
    }
  }
}
sidecar.close()

const fmt = (x) => Math.round(x * 10) / 10
console.log(
  JSON.stringify(
    {
      runtime: process.versions.electron ? `electron ${process.versions.electron} (node ${process.versions.node})` : `node ${process.versions.node}`,
      platform: `${process.platform}-${process.arch}`,
      rounds,
      startUs: { napiLoad: fmt(napiLoadUs), sidecarSpawnToFirstReply: fmt(sidecarFirstReplyUs) },
      jsToRustSmallJsonUs: { napi: fmt(median(results.napi.small)), sidecar: fmt(median(results.sidecar.small)) },
      jsToRust1MiBUs: { napi: fmt(median(results.napi.big)), sidecar: fmt(median(results.sidecar.big)) },
      rustToJsUs: {
        napi: fmt(median(results.napi.pings)),
        napiP99: fmt(results.napi.pingsP99),
        sidecar: fmt(median(results.sidecar.pings)),
        sidecarP99: fmt(results.sidecar.pingsP99),
      },
      payloadBytes: { small: smallArgs.length, big: big.length },
    },
    null,
    2,
  ),
)
