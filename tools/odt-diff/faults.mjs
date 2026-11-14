// One Rust fault at a time, through the same comparisons as the parity gate.
//
// Each fault is one source replacement `[name, compared function, file,
// original, faulty, occurrences?]` applied to a scratch copy of crates/, with
// one wasm build and one comparison per fault. The compared function is
// either a function of comparison (f), `<group>.<name>` (the group of
// calls-groups.ts, e.g. `odtText.paraKeys`), or one of the four wire commands
// (`odtToDocx`, `saveOdt`, `docxToOdt`, `odtToText`), whose comparisons are
// (a), (b), (c) and (d) of main.ts.
//
// The integrator chose the faults without reading the porters' lists.
//
// A positive control runs first, on the build without a fault: the gate is
// run with ODT_DIFF_CONTROL=1, which changes every reply of the Rust side
// before it is compared, each compared value on its own (compare-odt.ts), and
// every outcome of (f) (main.ts). The run exits 2 when any comparison line that
// compared something shows no difference, and the faults do not start.
//
//   node faults.mjs [--inventory] [--only a,b] [--shard INDEX/COUNT] [--no-control]
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseShard, planShards, readCosts } from '../fault-shards.mjs'

if (Number(process.versions.node.split('.')[0]) !== 22)
  throw new Error('fault probes require Node 22')
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const leaf = 'crates/odt-engine/src/'
/** [name, compared function, file, original, faulty, occurrences of the original (1)] */
const faults = [
  [
    'page-right-round',
    'odtToDocx',
    leaf + 'page/geometry.rs',
    'right: JsNum(math_round(margin(p, "right").unwrap_or(DEFAULT_MARGIN))),',
    'right: JsNum(margin(p, "right").unwrap_or(DEFAULT_MARGIN).round()),',
  ],
  [
    'package-central-order',
    'saveOdt',
    leaf + 'core/package.rs',
    'records.sort_by_key(|r| r.offset);',
    'records.sort_by_key(|r| std::cmp::Reverse(r.offset));',
  ],
  [
    'styles-chain-order',
    'odtToDocx',
    leaf + 'core/styles.rs',
    'layers.extend(chain.iter().rev());',
    'layers.extend(chain.iter());',
  ],
  [
    'flow-neighbour-scan',
    'saveOdt',
    leaf + 'core/flow.rs',
    'while k > 0 && matched[k - 1].is_none() {',
    'while k > 1 && matched[k - 1].is_none() {',
  ],
  [
    'units-exponent-bound',
    'odtText.twipsToPt',
    leaf + 'text/units.rs',
    'x.abs() >= 1e21',
    'x.abs() > 1e21',
  ],
  [
    'props-bold-threshold',
    'odtText.textFormatFromOdf',
    leaf + 'text/props.rs',
    'parse_int(v, Radix::Ten) >= 600.0',
    'parse_int(v, Radix::Ten) > 600.0',
  ],
  [
    'props-size-floor',
    'odtText.textFormatFromOdf',
    leaf + 'text/props.rs',
    'JsNum(math_round(t / 10.0).max(1.0))',
    'JsNum(math_round(t / 10.0))',
  ],
  [
    'table-border-double',
    'odtTable.borderFromOdf',
    leaf + 'table/forward.rs',
    'if ooxml == "double" { 3.0 } else { 1.0 }',
    'if ooxml == "double" { 2.0 } else { 1.0 }',
  ],
  [
    'table-grid-min',
    'odtToDocx',
    leaf + 'table/forward.rs',
    'math_max(1.0, math_round((w.expect("checked above") / sum) * total))',
    'math_round((w.expect("checked above") / sum) * total)',
  ],
  [
    'table-row-height-twips',
    'odtToDocx',
    leaf + 'table/forward.rs',
    'let tw = math_round((height.cm * 1440.0) / 2.54);',
    'let tw = ((height.cm * 1440.0) / 2.54).floor();',
  ],
  [
    'objects-emu-cm',
    'odtObjects.emuToCm',
    leaf + 'objects/geometry.rs',
    'let cm = math_round((emu / EMU_PER_CM) * 1000.0) / 1000.0;',
    'let cm = math_round((emu / EMU_PER_CM) * 100.0) / 100.0;',
  ],
  [
    'objects-z-cap',
    'odtObjects.drawingXml',
    leaf + 'objects/geometry.rs',
    'math_min(1000000.0, a.z.0)',
    'a.z.0',
  ],
  [
    'page-margin-epsilon',
    'odtPage.layoutOverrides',
    leaf + 'page/geometry.rs',
    'if (new_margin - old_margin).abs() >= 0.5 {',
    'if (new_margin - old_margin).abs() > 0.5 {',
  ],
  [
    'page-header-top',
    'odtPage.layoutGeometry',
    leaf + 'page/geometry.rs',
    'top: JsNum(math_round(top + h.height + h.spacing)),',
    'top: JsNum(math_round(top + h.height)),',
  ],
  [
    'rows-floor-cmp',
    'docxToOdt',
    leaf + 'assemble/export/rows.rs',
    'if floor <= 0.0 || floor <= current {',
    'if floor <= 0.0 || floor < current {',
  ],
  [
    'export-columns-half-gap',
    'odtAssemble.columnsXml',
    leaf + 'assemble/export/styles.rs',
    'let half = twips_to_length(gap / 2.0);',
    'let half = twips_to_length(gap);',
  ],
  [
    'zip-dos-seconds',
    'docxToOdt',
    leaf + 'assemble/zip.rs',
    '((date.seconds as i32) >> 1)',
    '(date.seconds as i32)',
  ],
  [
    'text-cell-join',
    'odtToText',
    leaf + 'assemble/text.rs',
    '.map(|r| r.join("\\t"))',
    '.map(|r| r.join(" "))',
  ],
  [
    'text-trim-end',
    'odtToText',
    leaf + 'assemble/text.rs',
    "let line = c.text.trim_end_matches(' ').to_owned();",
    'let line = c.text.trim_end().to_owned();',
  ],
  [
    'report-count-sum',
    'odtToDocx',
    leaf + 'assemble/report.rs',
    'self.counts[row][feature.index()] += count;',
    'self.counts[row][feature.index()] = count;',
  ],
  [
    'meta-people-swap',
    'odtToDocx',
    leaf + 'assemble/meta.rs',
    'last_modified_by: meta_field(meta, "dc:creator"),',
    'last_modified_by: meta_field(meta, "meta:initial-creator"),',
  ],
  [
    'markers-end-bias',
    'saveOdt',
    leaf + 'text/markers.rs',
    'let mut b = a.max(at(end.offset, Bias::End));',
    'let mut b = a.max(at(end.offset, Bias::Start));',
  ],
  [
    'paragraph-odf-bias',
    'saveOdt',
    leaf + 'text/paragraph_odf.rs',
    'MapBias::End => Bias::End,',
    'MapBias::End => Bias::Start,',
  ],
  [
    'page-section-continuous',
    'saveOdt',
    leaf + 'page/reverse.rs',
    '&& self.ext.sections[c].continuous\n',
    '&& !self.ext.sections[c].continuous\n',
  ],
  [
    'table-colspan-gt',
    'saveOdt',
    leaf + 'table/reverse.rs',
    'if spans.col_span > 1 {',
    'if spans.col_span > 2 {',
  ],
  [
    'objects-note-key',
    'saveOdt',
    leaf + 'objects/state.rs',
    'format!("{}:{id}", kind.as_str())',
    'id.to_string()',
  ],
]

const WIRE = { odtToDocx: '(a)', saveOdt: '(b)', docxToOdt: '(c)', odtToText: '(d)' }

const out = resolve(here, 'out/faults')
const target = resolve(root, 'crates/target/fault-probes')
const env = {
  ...process.env,
  CARGO_BUILD_JOBS: '4',
  CARGO_TARGET_DIR: target,
  // probe-dev (crates/Cargo.toml): the dev profile's checks at opt-level 1, so
  // a wire-command fault's whole gate takes minutes instead of over an hour
  SEUOFFICE_WASM: resolve(target, 'wasm32-wasip1/probe-dev/office_wasm.wasm'),
}
if (process.argv.includes('--inventory')) {
  let stale = 0
  for (const [id, , file, before, , occurrences = 1] of faults) {
    const count = readFileSync(resolve(root, file), 'utf8').split(before).length - 1
    if (count !== occurrences) stale++
    console.log(`${count === occurrences ? 'OK' : 'STALE'} ${id}: ${count}/${occurrences}`)
  }
  if (new Set(faults.map(([id]) => id)).size !== faults.length)
    throw new Error('a fault id repeats')
  console.log(`${faults.length} faults`)
  process.exit(stale === 0 ? 0 : 1)
}
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt === -1 ? null : new Set(process.argv[onlyAt + 1].split(','))
// `--shard INDEX/COUNT`: one of COUNT runners side by side, each with the
// faults tools/fault-shards.mjs gives it by the seconds in fault-costs.json
const shardAt = process.argv.indexOf('--shard')
const { index: shard, count: shards } =
  shardAt === -1 ? { index: 0, count: 1 } : parseShard(process.argv[shardAt + 1])
const named = faults.filter(([id]) => only === null || only.has(id))
if (only !== null && named.length !== only.size) throw new Error('--only names an unknown fault')
const planned = new Set(
  planShards(
    named.map(([id]) => id),
    readCosts(resolve(here, 'fault-costs.json')),
    shards,
  ).shards[shard],
)
const selected = named.filter(([id]) => planned.has(id))
mkdirSync(out, { recursive: true })
if (selected.length === 0 && !process.argv.includes('--control-only')) {
  console.log('odt-diff faults: no fault selected, nothing to build')
  process.exit(0)
}

// A scratch copy: an interrupted probe leaves no fault in the working tree.
const workspace = mkdtempSync(join(tmpdir(), 'odt-faults-'))
cpSync(resolve(root, 'crates'), resolve(workspace, 'crates'), {
  recursive: true,
  filter: (source) => {
    const path = relative(resolve(root, 'crates'), source)
    return path !== 'target' && !path.startsWith(`target${sep}`)
  },
})
const args = [
  'build',
  '--locked',
  '--target',
  'wasm32-wasip1',
  '--manifest-path',
  resolve(workspace, 'crates/Cargo.toml'),
  '-p',
  'office-wasm',
  '--profile',
  'probe-dev',
  '-j4',
]
const run = (program, programArgs, extraEnv = {}) =>
  spawnSync(program, programArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...env, ...extraEnv },
  })
const mainArgs = [
  resolve(root, 'node_modules/tsx/dist/cli.mjs'),
  resolve(here, 'main.ts'),
  '--by-function',
]

/**
 * Differences the run shows on every comparison line (`(a)` ... `(f+)`), and
 * its panics: the gate's own verdict. The function a fault names is where it
 * was meant to show; any line counts, since a fault the gate sees anywhere
 * fails the gate. Null where the run ended before its tally.
 */
function differencesOf(text) {
  let total = 0
  let found = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const panics = /^rust panics .*: (\d+)$/.exec(trimmed)
    if (panics) total += Number(panics[1])
    if (!/^\([a-f]\+?\) /.test(trimmed)) continue
    const count = /\bdifferences\s+(\d+)/.exec(trimmed)
    if (count) {
      found = true
      total += Number(count[1])
    }
  }
  return found ? total : null
}

const baselineBuild = run('cargo', args)
if (baselineBuild.status !== 0) throw new Error(baselineBuild.stderr || String(baselineBuild.error))

if (!process.argv.includes('--no-control')) {
  // main.ts under ODT_DIFF_CONTROL=1 exits 2 when a comparison line that compared something shows no difference
  const control = run(process.execPath, mainArgs, {
    ODT_DIFF_OUT: resolve(out, 'control'),
    ODT_DIFF_CONTROL: '1',
  })
  const text = (control.stdout ?? '') + (control.stderr ?? '')
  writeFileSync(resolve(out, 'control.log'), text)
  if (control.status !== 0) {
    console.error(
      'positive control failed (status ' +
        control.status +
        '): the lines below saw no difference: out/faults/control.log',
    )
    for (const line of text.split('\n').filter((l) => l.startsWith('CONTROL BLIND')))
      console.error('  ' + line)
    process.exit(2)
  }
  console.log('positive control: every comparison line sees a changed reply')
}

const results = []
for (const [id, fn, file, before, after, occurrences = 1] of selected) {
  const path = resolve(workspace, file)
  const original = readFileSync(path, 'utf8')
  const count = original.split(before).length - 1
  if (count !== occurrences)
    throw new Error(`${id}: source anchor occurs ${count}, expected ${occurrences}`)
  let result
  const started = Date.now()
  try {
    // a function: `$` in the fault text is not a replacement pattern
    writeFileSync(
      path,
      original.replace(before, () => after),
    )
    const build = run('cargo', args)
    if (build.status !== 0) throw new Error(build.stderr || String(build.error))
    const wire = Object.hasOwn(WIRE, fn)
    // a function of (f): only its group, the baseline compared them all; a wire command: the whole gate
    const compared = wire
      ? run(process.execPath, mainArgs, { ODT_DIFF_OUT: resolve(out, id) })
      : run(process.execPath, [...mainArgs, '--calls-only', '--group', fn.split('.')[0]], {
          ODT_DIFF_OUT: resolve(out, id),
        })
    writeFileSync(resolve(out, `${id}.log`), (compared.stdout ?? '') + (compared.stderr ?? ''))
    const differences = differencesOf(compared.stdout ?? '')
    // no tally: the comparison ended before its report (the fault made the module abort)
    const aborted = differences === null
    result = {
      id,
      fn,
      file,
      before,
      after,
      differences: differences ?? 0,
      aborted,
      caught: (differences ?? 0) > 0,
      // its build and its comparison: the cost tools/fault-shards.mjs plans by
      seconds: (Date.now() - started) / 1000,
    }
  } finally {
    writeFileSync(path, original)
  }
  results.push(result)
  console.log(
    result.aborted
      ? `ABORTED ${id}: ${fn}, the comparison ended without its tally: out/faults/${id}.log`
      : `${result.caught ? 'CAUGHT' : 'MISSED'} ${id}: ${fn}, ${result.differences} differences`,
  )
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(results, null, 2) + '\n')
}
rmSync(workspace, { recursive: true, force: true })
process.exit(results.every((result) => result.caught) ? 0 : 1)
