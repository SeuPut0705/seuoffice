// Start cost alone, in a fresh process: load the addon, or spawn the sidecar
// until its first answer. Run several times; the first run after a build
// includes the system's scan of a new binary.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const release = join(dirname(fileURLToPath(import.meta.url)), 'target', 'release')
const now = () => Number(process.hrtime.bigint()) / 1000
const which = process.argv[2]
if (which === 'napi') {
  const s = now()
  createRequire(import.meta.url)(join(release, 'spike_main_bridge.node')).call('x', '1')
  console.log(Math.round(now() - s))
} else {
  const s = now()
  const child = spawn(join(release, 'sidecar'), [], { stdio: ['pipe', 'pipe', 'inherit'] })
  const body = Buffer.from('{"name":"x","args":1}')
  const head = Buffer.alloc(5); head.writeUInt32LE(body.length + 1, 0); head[4] = 1
  child.stdout.once('data', () => { console.log(Math.round(now() - s)); child.stdin.end() })
  child.stdin.write(Buffer.concat([head, body]))
}
