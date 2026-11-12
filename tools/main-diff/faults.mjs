// Fault injection for the central process comparison (decision 0029): each
// fault of a file changes one place of the Rust, the addon is rebuilt, and the
// comparison of the fault's functions must then report a difference.
//
//   node tools/main-diff/faults.mjs tools/main-diff/faults/b1.json[,more.json...]
//
// A faults file is a JSON array of
//   { "name": "...", "file": "<path under crates/>", "find": "<text>",
//     "replace": "<text>", "fn": ["<function>", ...] }
// `find` must occur exactly once in the file. The first entry of each file is
// the positive control: a fault known to show. When it is missed the run stops, because a
// comparison that sees nothing proves nothing. Each fault is undone before the
// next, also when the build fails.
//
// Verdicts: CAUGHT (an unlisted difference), MISSED (the comparison passed:
// name an input that would show it), BUILD (the faulted Rust does not build:
// not a fault, rewrite it), BAD (find is not there exactly once).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = dirname(fileURLToPath(import.meta.url))
const crates = resolve(tool, '../../crates')
const files = process.argv[2].split(',').filter(Boolean)
// FAULT_SHARD=i/n runs the entries whose index is i modulo n, and each file's
// positive control in every shard
const [shard, shards] = (process.env.FAULT_SHARD ?? '0/1').split('/').map(Number)
// each fault rebuilds the addon: unoptimized and incremental, unless asked otherwise
process.env.MAIN_DIFF_PROFILE ??= 'node-faults'
const results = []

function compare(fns) {
  const args = ['tsx', 'main.ts', '--show', '3', ...fns.flatMap((f) => ['--fn', f])]
  const run = spawnSync('npx', args, { cwd: tool, encoding: 'utf8' })
  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

for (const file of files) {
  const faults = JSON.parse(readFileSync(resolve(file), 'utf8'))
  console.log(`\n${file}`)
  for (const [i, fault] of faults.entries()) {
    if (i !== 0 && i % shards !== shard) continue
    const path = join(crates, fault.file)
    const original = readFileSync(path, 'utf8')
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
        const { status, out } = compare(fault.fn)
        verdict = status === 0 ? 'MISSED' : /^DIFF /m.test(out) ? 'CAUGHT' : 'MISSED'
        detail = out
          .split('\n')
          .filter(
            (l) =>
              l.startsWith('DIFF ') || / checks, \d+ equal/.test(l) || /FLOOR|STALE|Error/.test(l),
          )
          .slice(0, 4)
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
    results.push({
      faults: file,
      name: fault.name,
      file: fault.file,
      fn: fault.fn,
      verdict,
      detail,
    })
    console.log(`${verdict.padEnd(6)} ${fault.name}${detail ? `  (${detail})` : ''}`)
    if (i === 0 && verdict !== 'CAUGHT') {
      console.log('the positive control was not caught: skipping the rest of this file')
      process.exitCode = 1
      break
    }
  }
}

const out = join(tool, 'out')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'faults.json'), `${JSON.stringify(results, null, 2)}\n`)
const count = (v) => results.filter((r) => r.verdict === v).length
console.log(
  `\n${results.length} faults: ${count('CAUGHT')} caught, ${count('MISSED')} missed, ${count('BUILD')} not building, ${count('BAD')} bad`,
)
// rebuild the unfaulted addon, so a later step compares the code as it is
execFileSync('node', ['build.mjs'], { cwd: tool, stdio: 'inherit' })
