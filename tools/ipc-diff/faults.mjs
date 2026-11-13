// Fault injection for the IPC comparison (the stage 3 shell contract,
// section 8): each fault of a file changes one place of the Rust, ipc-probe
// is rebuilt, and the comparison of the fault's groups must then report a
// difference.
//
//   node tools/ipc-diff/faults.mjs tools/ipc-diff/faults/w.json[,more.json...]
//
// A faults file is a JSON array of
//   { "name": "...", "file": "<path under crates/>", "find": "<text>",
//     "replace": "<text>", "groups": ["w/quick-look", ...] }
// `find` must occur exactly once in the file. The first entry of each file is
// the positive control; when it is missed the rest of the file is skipped.
// Each fault is undone before the next, also when the build fails.
//
// Verdicts: CAUGHT (an unlisted difference), MISSED (the comparison passed),
// BUILD (the faulted Rust does not build), BAD (find is not there once).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = dirname(fileURLToPath(import.meta.url))
const crates = resolve(tool, '../../crates')
const files = process.argv[2].split(',').filter(Boolean)
// FAULT_SHARD=i/n runs the entries whose index is i modulo n, and each
// file's positive control in every shard
const [shard, shards] = (process.env.FAULT_SHARD ?? '0/1').split('/').map(Number)
const results = []

function compare(groups) {
  let status = 0
  let out = ''
  for (const group of groups) {
    const run = spawnSync('npx', ['tsx', 'main.ts', '--group', group, '--show', '3'], {
      cwd: tool,
      encoding: 'utf8',
    })
    status ||= run.status
    out += `${run.stdout}${run.stderr}`
  }
  return { status, out }
}

for (const file of files) {
  const faults = JSON.parse(readFileSync(resolve(file), 'utf8'))
  console.log(`\n${file}`)
  for (const [i, fault] of faults.entries()) {
    if (i !== 0 && i % shards !== shard) continue
    const path = join(crates, fault.file)
    const original = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const count = original.split(fault.find).length - 1
    let verdict
    let detail
    if (count !== 1) {
      verdict = 'BAD'
      detail = `find occurs ${count} times`
    } else {
      writeFileSync(path, original.replace(fault.find, fault.replace))
      try {
        execFileSync('node', ['build.mjs'], { cwd: tool, stdio: 'pipe' })
        const { status, out } = compare(fault.groups)
        verdict = status !== 0 && /^DIFF /m.test(out) ? 'CAUGHT' : 'MISSED'
        detail = out
          .split('\n')
          .filter((l) => l.startsWith('DIFF ') || / cases, \d+ equal/.test(l))
          .slice(0, 3)
          .join(' | ')
      } catch (err) {
        verdict = 'BUILD'
        detail = String(err.stderr ?? err)
          .split('\n')
          .filter((l) => /^error/.test(l))
          .slice(0, 2)
          .join(' | ')
      } finally {
        writeFileSync(path, original)
      }
    }
    results.push({ faults: file, name: fault.name, file: fault.file, verdict, detail })
    console.log(`${verdict.padEnd(6)} ${fault.name}${detail ? `  (${detail})` : ''}`)
    if (i === 0 && verdict !== 'CAUGHT') {
      console.log('the positive control was not caught: skipping the rest of this file')
      process.exitCode = 1
      break
    }
    if (verdict !== 'CAUGHT') process.exitCode = 1
  }
}

const out = join(tool, 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'faults.json'), `${JSON.stringify(results, null, 2)}\n`)
const count = (v) => results.filter((r) => r.verdict === v).length
console.log(
  `\n${results.length} faults: ${count('CAUGHT')} caught, ${count('MISSED')} missed, ${count('BUILD')} not building, ${count('BAD')} bad`,
)
// the unfaulted probe again, so a later step compares the code as it is
execFileSync('node', ['build.mjs'], { cwd: tool, stdio: 'inherit' })
