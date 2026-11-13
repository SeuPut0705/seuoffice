import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (Number(process.versions.node.split('.')[0]) !== 22) {
  console.error(`odt-diff requires Node 22, running ${process.version}`)
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const tsOnly = process.argv.includes('--ts-only')
if (!tsOnly) {
  // the wasm is built first: the comparison runs against it
  const built = spawnSync(process.execPath, [resolve(root, 'crates/office-wasm/build.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  if (built.status !== 0) process.exit(built.status ?? 1)
}
const run = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/tsx/dist/cli.mjs'),
    resolve(here, tsOnly ? 'ts-only.ts' : 'main.ts'),
    ...process.argv.slice(2).filter((argument) => argument !== '--ts-only'),
  ],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  },
)
mkdirSync(resolve(here, 'out'), { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-')
for (const [kind, text] of [
  ['stdout', run.stdout],
  ['stderr', run.stderr],
]) {
  writeFileSync(resolve(here, 'out', `${stamp}.${kind}.log`), text ?? '', { flag: 'wx' })
}
const firstAt = process.argv.indexOf('--record-first')
if (firstAt !== -1) {
  const unit = process.argv[firstAt + 1]
  if (!unit || !/^[a-z0-9-]+$/.test(unit)) throw new Error('invalid first-run unit name')
  const evidence = resolve(root, 'crates/odt-engine/evidence')
  mkdirSync(evidence, { recursive: true })
  for (const [kind, text] of [
    ['stdout', run.stdout],
    ['stderr', run.stderr],
  ])
    writeFileSync(resolve(evidence, `${unit}-first.${kind}.log`), text ?? '', { flag: 'wx' })
}
process.stdout.write(run.stdout ?? '')
process.stderr.write(run.stderr ?? '')
if (run.error) console.error(run.error)
console.log(`odt-diff: untouched output saved at tools/odt-diff/out/${stamp}.*.log`)
process.exit(run.status ?? 1)
