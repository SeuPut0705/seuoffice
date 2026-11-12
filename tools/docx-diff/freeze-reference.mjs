// B4: freeze the TypeScript engine, and point the gate at the frozen copy.
//
//   node tools/docx-diff/freeze-reference.mjs [--base <rev>] [--force]
//
// 1. Copies every file of packages/docx-engine/src (the .ts files and vendor/)
//    as it is at <rev> (default HEAD) into tools/docx-diff/reference/, byte for
//    byte, from the git object, never from the working tree: the binding
//    generator overwrites the working tree files. Refuses to run over an
//    existing reference/ without --force.
// 2. Repoints every reference to packages/docx-engine/src in the files of
//    tools/docx-diff (this directory only; binding/, out/ and reference/ are
//    left alone) to tools/docx-diff/reference: an import
//    '../../packages/docx-engine/src/x' becomes './reference/x', a path
//    'packages/docx-engine/src/x' becomes 'tools/docx-diff/reference/x'.
//    Run a second time it finds nothing to change.
//
// The reference is what the gate compares the binding with (decision 0025):
// it is frozen at the B4 base and never edited.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const SRC = 'packages/docx-engine/src'
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
  const names = git(['ls-tree', '-r', '--name-only', commit, '--', SRC]).toString().split('\n').filter(Boolean)
  for (const name of names) {
    const target = join(REFERENCE, name.slice(SRC.length + 1))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, git(['show', `${commit}:${name}`]))
  }
  writeFileSync(
    join(REFERENCE, 'README.md'),
    `# The frozen TypeScript engine\n\n` +
      `packages/docx-engine/src as it was at ${commit}, copied by tools/docx-diff/freeze-reference.mjs.\n` +
      `The gate (tools/docx-diff) imports this copy, never packages/docx-engine/src, which holds the\n` +
      `binding over the wasm engine. Do not edit these files.\n`,
  )
  console.log(`froze ${names.length} files of ${SRC} at ${commit}`)
}

// ---------------------------------------------------------------- 2. repoint

const TEXT = /\.(ts|mjs|cjs|py|sh|json)$/
const own = 'freeze-reference.mjs'
let changed = 0
for (const entry of readdirSync(here, { withFileTypes: true })) {
  if (!entry.isFile() || !TEXT.test(entry.name) || entry.name === own) continue
  const file = join(here, entry.name)
  const before = readFileSync(file, 'utf8')
  const after = before
    // from tools/docx-diff: '../../packages/docx-engine/src/x' is './reference/x'
    .replace(/(?:\.\.\/)+packages\/docx-engine\/src(?![A-Za-z0-9_-])/g, './reference')
    .replace(/packages\/docx-engine\/src(?![A-Za-z0-9_-])/g, 'tools/docx-diff/reference')
  if (after !== before) {
    writeFileSync(file, after)
    changed += 1
    console.log(`repointed ${entry.name}`)
  }
}
console.log(`${changed} files repointed`)
