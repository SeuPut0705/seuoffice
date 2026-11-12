// D3: freeze the TypeScript readers, and point the gate at the frozen copy.
//
//   node tools/fileparse-diff/freeze-reference.mjs [--base <rev>] [--force]
//
// 1. Copies packages/file-parse/src as it is at <rev> (default HEAD) into
//    tools/fileparse-diff/reference/, from the git object, never from the
//    working tree, which holds the binding. Package names are written as the
//    internal rename has them (@seuoffice/*), and @seuoffice/docx-engine is the
//    frozen docx engine (tools/docx-diff/reference), so the reference runs no
//    Rust. Refuses to run over an existing reference/ without --force.
// 2. Repoints every import of packages/file-parse/src in the files of
//    tools/fileparse-diff (this directory only; out/, evidence/ and
//    reference/ are left alone) to ./reference, except host-steps: the gate
//    answers the engine's host steps with the product's own. Run a second
//    time it finds nothing to change.
//
// The reference is what the gate compares the readers with (decision 0025):
// it is frozen at the D3 base and never edited.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const SRC = 'packages/file-parse/src'
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
  console.log('reference/ exists: not frozen again (--force to replace it)')
} else {
  const commit = git(['rev-parse', base]).toString().trim()
  const names = git(['ls-tree', '-r', '--name-only', commit, '--', SRC])
    .toString()
    .split('\n')
    .filter(Boolean)
  for (const name of names) {
    const target = join(REFERENCE, name.slice(SRC.length + 1))
    const depth = name.slice(SRC.length + 1).split('/').length - 1
    const docxReference = `${'../'.repeat(depth + 2)}docx-diff/reference/index`
    let text = git(['show', `${commit}:${name}`]).toString()
    if (name.endsWith('.ts')) {
      text = text
        .replace(/@genoffice\//g, '@seuoffice/')
        .replace(/'@seuoffice\/docx-engine'/g, `'${docxReference}'`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  writeFileSync(
    join(REFERENCE, 'README.md'),
    `# The frozen TypeScript readers\n\n` +
      `packages/file-parse/src as it was at ${commit}, copied by tools/fileparse-diff/freeze-reference.mjs\n` +
      `(package names as the internal rename writes them; @seuoffice/docx-engine is tools/docx-diff/reference).\n` +
      `The gate (tools/fileparse-diff) imports this copy, never packages/file-parse/src, which holds the\n` +
      `binding over the wasm engine. Do not edit these files.\n`,
  )
  console.log(`froze ${names.length} files of ${SRC} at ${commit}`)
}

// ---------------------------------------------------------------- 2. repoint

const TEXT = /\.(ts|mjs|cjs|json)$/
const own = 'freeze-reference.mjs'
let changed = 0
for (const entry of readdirSync(here, { withFileTypes: true })) {
  if (!entry.isFile() || !TEXT.test(entry.name) || entry.name === own) continue
  const file = join(here, entry.name)
  const before = readFileSync(file, 'utf8')
  const after = before
    .replace(/(?:\.\.\/)+packages\/file-parse\/src\/(?!host-steps\b)/g, './reference/')
    .replace(/(?<![./])packages\/file-parse\/src\/(?!host-steps\b)/g, 'tools/fileparse-diff/reference/')
  if (after !== before) {
    writeFileSync(file, after)
    changed += 1
    console.log(`repointed ${entry.name}`)
  }
}
console.log(`${changed} files repointed`)
