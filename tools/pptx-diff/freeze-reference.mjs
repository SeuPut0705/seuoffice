// C2: freeze the TypeScript engine, and point the gate at the frozen copy.
//
//   node tools/pptx-diff/freeze-reference.mjs [--base <rev>] [--force]
//
// 1. Copies every file of packages/pptx-engine/src (the .ts files and vendor/)
//    as it is at <rev> (default HEAD) into tools/pptx-diff/reference/, byte for
//    byte, from the git object, never from the working tree: the binding
//    generator overwrites the working tree files. Refuses to run over an
//    existing reference/ without --force.
// 2. Repoints every reference to packages/pptx-engine/src in the files of
//    tools/pptx-diff (this directory only; binding/, out/ and reference/ are
//    left alone) to tools/pptx-diff/reference: an import
//    '../../packages/pptx-engine/src/x' becomes './reference/x', a path
//    'packages/pptx-engine/src/x' becomes 'tools/pptx-diff/reference/x'.
//    Run a second time it finds nothing to change.
//
// The reference is what the gate compares the binding with (decision 0025, crates/pptx-engine/C2-PLAN.md):
// it is frozen at the C2 base and never edited.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const SRC = 'packages/pptx-engine/src'
const REFERENCE = join(here, 'reference')

const argAfter = (flag) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}
const base = argAfter('--base') ?? 'HEAD'
const force = process.argv.includes('--force')

const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30 })

// ---------------------------------------------------------------- 1. freeze

if (existsSync(REFERENCE) && !force) {
  console.log(`reference/ exists: not frozen again (--force to replace it)`)
} else {
  const commit = git(['rev-parse', base]).toString().trim()
  // the binding's own modules (engine.ts, engine-*.ts) are not the engine
  const names = git(['ls-tree', '-r', '--name-only', commit, '--', SRC])
    .toString()
    .split('\n')
    .filter((name) => name && !/^packages\/pptx-engine\/src\/engine(?:-[a-z]+)?\.ts$/.test(name))
  for (const name of names) {
    const target = join(REFERENCE, name.slice(SRC.length + 1))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, git(['show', `${commit}:${name}`]))
  }
  writeFileSync(
    join(REFERENCE, 'README.md'),
    `# The frozen TypeScript engine\n\n` +
      `packages/pptx-engine/src as it was at ${commit}, copied by tools/pptx-diff/freeze-reference.mjs.\n` +
      `The gate (tools/pptx-diff) imports this copy, never packages/pptx-engine/src, which holds the\n` +
      `binding over the wasm engine. Do not edit these files.\n`,
  )
  console.log(`froze ${names.length} files of ${SRC} at ${commit}`)
}

// ---------------------------------------------------------------- 2. repoint

const TEXT = /\.(ts|mjs|cjs|py|sh|json)$/
const own = 'freeze-reference.mjs'
let changed = 0
for (const entry of readdirSync(here, { withFileTypes: true })) {
  // the render benchmark names the binding and the reference apart on purpose
  if (!entry.isFile() || !TEXT.test(entry.name) || entry.name === own || entry.name.startsWith('bench-')) continue
  const file = join(here, entry.name)
  const before = readFileSync(file, 'utf8')
  const after = before
    // from tools/pptx-diff: '../../packages/pptx-engine/src/x' is './reference/x'
    .replace(/(?:\.\.\/)+packages\/pptx-engine\/src(?![A-Za-z0-9_-])/g, './reference')
    .replace(/packages\/pptx-engine\/src(?![A-Za-z0-9_-])/g, 'tools/pptx-diff/reference')
  if (after !== before) {
    writeFileSync(file, after)
    changed += 1
    console.log(`repointed ${entry.name}`)
  }
}
console.log(`${changed} files repointed`)
