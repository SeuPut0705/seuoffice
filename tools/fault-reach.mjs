/**
 * Which engines' fault probes a branch can reach, from what it changed.
 *
 *   node tools/fault-reach.mjs <base-ref> [--github-output]
 *   node tools/fault-reach.mjs --mode
 *       prints all|affected from GITHUB_EVENT_NAME, GITHUB_REF, ALL_FAULTS,
 *       DOCX_FAULTS and ODT_FAULTS before the workflow chooses --all or a base
 *
 * prints one line per engine, `run` or `skip` and why, and with
 * --github-output writes `<engine>=true|false` to $GITHUB_OUTPUT. The base is
 * the commit the branch left main at (the caller passes the merge base).
 *
 * An engine's faults are skipped only when no changed file can change what
 * its fault probes run: the runner (ENGINES[].runner), the wasm it builds, and
 * the comparisons it starts (ENGINES[].entries). They reach code and data in
 * three ways, and the rule follows each:
 *   - the wasm: a file of a crate in the engine crate's build closure (normal
 *     and build dependencies, from `cargo metadata`) reaches it. In
 *     crates/office-wasm, calls/<engine>_*.rs and <engine>.rs reach that
 *     engine, unless a file of another engine or a shared one (the
 *     dispatchers lib.rs and calls/mod.rs aside) names the module; every other
 *     office-wasm file, and a file of crates/ in no crate, reaches all;
 *   - the comparisons' code and what it reads by path: a file in a folder
 *     (`packages/<x>`, `tools/<x>`, ...) of the comparisons' TypeScript
 *     program (`tsc --listFilesOnly` from the entries) or of the runner, or a
 *     path that code names as a string literal, reaches it;
 *   - the corpus: a document of a type the code lists with
 *     `git ls-files '*.<ext>'` reaches it, wherever it lies.
 * Files not covered by those dependency rules conservatively reach every
 * engine. Only unmatched documentation under docs/ is excluded. A main push,
 * an untargeted manual main run, and `all_faults` select every engine and
 * every DOCX catalog. Explicit all plus a targeted selection is an error.
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Each engine with fault probes: its crate, its fault runner, and the
 * comparisons the runner starts. A new engine with fault probes gets a row.
 */
export const ENGINES = {
  docx: {
    crate: 'docx-engine',
    runner: 'tools/docx-diff/faults.py',
    entries: ['tools/docx-diff/calls-only.ts', 'tools/docx-diff/model-full.ts'],
  },
  pptx: {
    crate: 'pptx-engine',
    runner: 'tools/pptx-diff/faults.mjs',
    entries: ['tools/pptx-diff/main.ts'],
  },
  odt: {
    crate: 'odt-engine',
    runner: 'tools/odt-diff/faults.mjs',
    entries: ['tools/odt-diff/main.ts'],
  },
}

/** The DOCX catalogs a run must execute, or a deliberately targeted catalog. */
export function docxFaultFiles({ requested = '', reached, files }) {
  if (requested) return [requested]
  if (!reached) return []
  const catalogs = files
    .filter((file) => /^tools\/docx-diff\/faults-[^/]+\.json$/.test(file))
    .sort()
  if (catalogs.length === 0) throw new Error('no DOCX fault catalogs found for a reached engine')
  return catalogs
}

export function faultMode({ eventName, ref, allFaults, docxFaults, odtFaults }) {
  const targeted = Boolean(docxFaults || odtFaults)
  if (allFaults && targeted)
    throw new Error('all faults cannot be combined with a targeted fault selection')
  if (allFaults) return 'all'
  if (
    ref === 'refs/heads/main' &&
    (eventName === 'push' || (eventName === 'workflow_dispatch' && !targeted))
  )
    return 'all'
  return 'affected'
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (program, args) =>
  execFileSync(program, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 })

/** Local crates: their folder, and the local crates each one's build pulls in. */
export function crateGraph(metadata) {
  const local = metadata.packages.filter((p) => p.source === null)
  const nameOf = new Map(local.map((p) => [p.id, p.name]))
  const dirs = new Map(local.map((p) => [p.name, relative(root, dirname(p.manifest_path))]))
  const deps = new Map(local.map((p) => [p.name, []]))
  for (const node of metadata.resolve.nodes) {
    if (!nameOf.has(node.id)) continue
    // dev-dependencies are not in the wasm a gate runs
    for (const dep of node.deps)
      if (nameOf.has(dep.pkg) && dep.dep_kinds.some((k) => k.kind !== 'dev'))
        deps.get(nameOf.get(node.id)).push(nameOf.get(dep.pkg))
  }
  const closure = (name, seen = new Set()) => {
    if (seen.has(name)) return seen
    seen.add(name)
    for (const dep of deps.get(name) ?? []) closure(dep, seen)
    return seen
  }
  return { dirs, closure }
}

/**
 * What each fault runner reads: the files of the comparisons' TypeScript
 * program (`tsc --listFilesOnly` from its entries, with its gate's tsconfig)
 * and the runner itself, the paths that code names as strings, and the
 * document types it lists from git.
 */
export function gatePrograms(engines) {
  const programs = {}
  const scratch = mkdtempSync(join(tmpdir(), 'fault-reach-'))
  try {
    for (const [engine, { runner, entries }] of Object.entries(engines)) {
      const tsconfig = join(scratch, `${engine}.json`)
      writeFileSync(
        tsconfig,
        JSON.stringify({
          extends: resolve(root, dirname(entries[0]), 'tsconfig.json'),
          // types resolve from the config's folder, which is a scratch one
          compilerOptions: { typeRoots: [resolve(root, 'node_modules/@types')] },
          files: entries.map((entry) => resolve(root, entry)),
          include: [],
        }),
      )
      const listed = run(process.execPath, [
        resolve(root, 'node_modules/typescript/bin/tsc'),
        '-p',
        tsconfig,
        '--listFilesOnly',
      ])
        .split('\n')
        .filter(Boolean)
        .map((file) => relative(root, file))
        .filter((file) => !file.startsWith('..') && !file.includes('node_modules/'))
      // the runner's own imports (the shard planner) are .mjs, outside tsc's program
      const runnerCode = readFileSync(resolve(root, runner), 'utf8')
      const runnerImports = [...runnerCode.matchAll(/from '(\.[^']+\.mjs)'/g)].map(([, path]) =>
        relative(root, resolve(root, dirname(runner), path)),
      )
      const files = new Set([...listed, runner, ...runnerImports])
      const paths = new Set()
      const corpus = new Set()
      for (const file of files) {
        const code = readFileSync(resolve(root, file), 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\/?\*|#)/.test(line))
          .join('\n')
        // a path the code names as a string: a file, or with a trailing slash
        // or a template's `${`, every file under it
        for (const [, path] of code.matchAll(
          /['"`](?:\.\.\/)*((?:packages|apps|tools|crates|fixtures|vendor)\/[A-Za-z0-9_./-]*)/g,
        ))
          paths.add(/\.[a-z0-9]+$/.test(path) ? path : path.replace(/\/?$/, '/'))
        for (const [, ext] of code.matchAll(/ls-files[^\n]*?'\*\.([a-z0-9]+)'/g)) corpus.add(ext)
      }
      programs[engine] = { files, paths, corpus }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return programs
}

/**
 * For each engine, whether `changed` reaches it and the files that do.
 * @param {string[]} changed repository paths
 */
export function reach(changed, { engines, graph, programs, officeWasmText }) {
  const names = Object.keys(engines)
  const all = new Set(names)
  // the deepest crate folder holding the file
  const crateDirs = [...graph.dirs].sort(([, a], [, b]) => b.length - a.length)
  const ownerCrate = (file) => crateDirs.find(([, dir]) => file.startsWith(`${dir}/`))?.[0]
  const byCrate = (crate) =>
    new Set(names.filter((e) => graph.closure(engines[e].crate).has(crate)))

  /** The engines one office-wasm file reaches by the wasm. */
  const officeWasm = (file) => {
    const match = /^crates\/office-wasm\/src\/(?:calls\/)?([a-z]+)(?:_[a-z0-9_]+)?\.rs$/.exec(file)
    const engine = match?.[1]
    if (!engine || !names.includes(engine) || file.endsWith('/lib.rs') || file.endsWith('/mod.rs'))
      return all
    const module = file.split('/').pop().slice(0, -3)
    const ownedBy = (other) =>
      new RegExp(`^crates/office-wasm/src/(?:calls/)?${engine}(?:_[a-z0-9_]+)?\\.rs$`).test(other)
    const named = Object.entries(officeWasmText).some(
      ([other, text]) =>
        !ownedBy(other) &&
        !other.endsWith('/lib.rs') &&
        !other.endsWith('calls/mod.rs') &&
        new RegExp(`\\b${module}\\b`).test(text),
    )
    return named ? all : new Set([engine])
  }

  /** @returns {Set<string>} */
  const reached = (file) => {
    const folder = file.split('/').slice(0, 2).join('/')
    const ext = /\.([a-z0-9]+)$/.exec(file)?.[1]
    const p = (e) => programs[e]
    // a folder the comparisons import from: they may read any file of it by a
    // path relative to their own (a data file, a package.json Node resolves)
    const folders = (e) =>
      new Set(
        [...p(e).files]
          .map((f) => f.split('/').slice(0, 2).join('/'))
          .filter((f) => !f.startsWith('crates/')),
      )
    const byPath = names.filter(
      (e) =>
        folders(e).has(folder) ||
        [...p(e).paths].some((path) =>
          path.endsWith('/') ? file.startsWith(path) : file === path,
        ) ||
        (ext && p(e).corpus.has(ext)),
    )
    let byWasm = new Set()
    // a crate's manifest can turn on a feature of a dependency the engines
    // share, and cargo builds that dependency once with every feature asked for
    if (/^crates\/(.+\/)?Cargo\.toml$/.test(file)) return all
    if (file.startsWith('crates/office-wasm/')) byWasm = officeWasm(file)
    else if (file.startsWith('crates/')) {
      const crate = ownerCrate(file)
      if (crate === undefined) return all
      byWasm = byCrate(crate)
    }
    const hits = new Set([...byWasm, ...byPath])
    if (hits.size > 0 || file.startsWith('crates/')) return hits
    if (file.startsWith('docs/')) return hits
    return all
  }

  const result = Object.fromEntries(names.map((e) => [e, []]))
  for (const file of changed) for (const e of reached(file)) result[e].push(file)
  return result
}

function main(args) {
  const flags = args.filter((arg) => arg.startsWith('--'))
  if (flags.includes('--mode')) {
    console.log(
      faultMode({
        eventName: process.env.GITHUB_EVENT_NAME,
        ref: process.env.GITHUB_REF,
        allFaults: process.env.ALL_FAULTS === 'true',
        docxFaults: process.env.DOCX_FAULTS,
        odtFaults: process.env.ODT_FAULTS,
      }),
    )
    return
  }
  const base = args.find((arg) => !arg.startsWith('--'))
  const all = flags.includes('--all')
  if (!base && !all) {
    console.error('usage: node tools/fault-reach.mjs <base-ref>|--all [--github-output]')
    process.exit(2)
  }
  if (all && (process.env.DOCX_FAULTS || process.env.ODT_FAULTS))
    throw new Error('all faults cannot be combined with a targeted fault selection')
  let result
  if (all) {
    result = Object.fromEntries(
      Object.keys(ENGINES).map((engine) => [engine, ['all faults requested']]),
    )
  } else {
    const changed = run('git', ['diff', '--name-only', '--no-renames', base, 'HEAD'])
      .split('\n')
      .filter(Boolean)
    const metadata = JSON.parse(
      run('cargo', [
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--manifest-path',
        'crates/Cargo.toml',
      ]),
    )
    const officeWasmText = Object.fromEntries(
      run('git', ['ls-files', 'crates/office-wasm/src'])
        .split('\n')
        .filter((f) => f.endsWith('.rs') && existsSync(resolve(root, f)))
        .map((f) => [f, readFileSync(resolve(root, f), 'utf8')]),
    )
    result = reach(changed, {
      engines: ENGINES,
      graph: crateGraph(metadata),
      programs: gatePrograms(ENGINES),
      officeWasmText,
    })
  }
  for (const [engine, files] of Object.entries(result)) {
    const shown =
      files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '')
    console.log(
      files.length > 0 ? `run  ${engine}: ${shown}` : `skip ${engine}: no changed file reaches it`,
    )
    if (flags.includes('--github-output'))
      appendFileSync(process.env.GITHUB_OUTPUT, `${engine}=${files.length > 0}\n`)
  }
  const catalogs = docxFaultFiles({
    requested: process.env.DOCX_FAULTS,
    reached: result.docx.length > 0,
    files: readdirSync(resolve(root, 'tools/docx-diff')).map((file) => `tools/docx-diff/${file}`),
  })
  if (flags.includes('--github-output'))
    appendFileSync(process.env.GITHUB_OUTPUT, `docx_files=${JSON.stringify(catalogs)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2))
