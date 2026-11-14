import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as reachability from './fault-reach.mjs'

const planner = fileURLToPath(new URL('./fault-shards.mjs', import.meta.url))
const costs = fileURLToPath(new URL('./docx-diff/fault-costs.json', import.meta.url))

test('the shard CLI preserves every fault name in exactly one shard', () => {
  const ids = ['', 'one\ntwo', 'ordinary', 'quote"slash\\', '한글']
  const assigned = []
  for (let index = 0; index < 3; index++) {
    const result = spawnSync(process.execPath, [planner, 'pick', costs, `${index}/3`], {
      input: JSON.stringify(ids),
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assigned.push(...JSON.parse(result.stdout))
  }
  assert.deepEqual(assigned.sort(), [...ids].sort())
})

const engines = { docx: { crate: 'docx' }, pptx: { crate: 'pptx' }, odt: { crate: 'odt' } }
const context = {
  engines,
  graph: { dirs: new Map(), closure: (crate) => new Set([crate]) },
  programs: Object.fromEntries(
    Object.keys(engines).map((name) => [
      name,
      { files: new Set(), paths: new Set(), corpus: new Set() },
    ]),
  ),
  officeWasmText: {},
}

test('unclassified runtime source changes cannot skip engine fault probes', () => {
  for (const file of [
    'tools/runtime/new-reader.ts',
    'apps/unknown/plugin.tsx',
    'runtime/helper.rs',
  ]) {
    const result = reachability.reach([file], context)
    for (const name of Object.keys(engines)) assert.deepEqual(result[name], [file])
  }
})

test('all reached DOCX fault catalogs are selected without an explicit file input', () => {
  const files = ['tools/docx-diff/faults-b2.json', 'tools/docx-diff/faults-b4.json']
  assert.deepEqual(reachability.docxFaultFiles({ reached: true, files }), files)
  assert.deepEqual(reachability.docxFaultFiles({ reached: false, files }), [])
  assert.deepEqual(reachability.docxFaultFiles({ requested: files[1], reached: false, files }), [
    files[1],
  ])
  assert.throws(() => reachability.docxFaultFiles({ reached: true, files: [] }))
})

test('the all-faults CLI emits every engine and all DOCX catalogs for the workflow matrix', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fault-planning-'))
  const output = join(directory, 'github-output')
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fault-reach.mjs', import.meta.url)), '--all', '--github-output'],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output, DOCX_FAULTS: '', ODT_FAULTS: '' },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    const values = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const split = line.indexOf('=')
          return [line.slice(0, split), line.slice(split + 1)]
        }),
    )
    for (const engine of ['docx', 'pptx', 'odt', 'fileparse', 'epub'])
      assert.equal(values[engine], 'true')
    assert.deepEqual(JSON.parse(values.docx_files), [
      'tools/docx-diff/faults-b2.json',
      'tools/docx-diff/faults-b3.json',
      'tools/docx-diff/faults-b4.json',
      'tools/docx-diff/faults-chart.json',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('attachment fault selection follows shared engine dependencies without skipping unknown code', () => {
  const registered = reachability.ENGINES
  const deps = {
    'docx-engine': ['shared'],
    'pptx-engine': ['shared'],
    'odt-engine': ['shared'],
    'epub-engine': ['shared', 'epub-only'],
    'file-parse': ['shared', 'epub-engine', 'epub-only', 'attachment-only'],
  }
  const graph = {
    dirs: new Map([
      ['shared', 'crates/shared'],
      ['epub-only', 'crates/epub-only'],
      ['attachment-only', 'crates/attachment-only'],
    ]),
    closure: (crate) => new Set([crate, ...deps[crate]]),
  }
  const programs = Object.fromEntries(
    Object.keys(registered).map((name) => [
      name,
      { files: new Set(), paths: new Set(), corpus: new Set() },
    ]),
  )
  const select = (file) => {
    const result = reachability.reach([file], {
      engines: registered,
      graph,
      programs,
      officeWasmText: {},
    })
    return Object.keys(result)
      .filter((engine) => result[engine].length > 0)
      .sort()
  }
  assert.deepEqual(select('crates/attachment-only/src/lib.rs'), ['fileparse'])
  assert.deepEqual(select('crates/epub-only/src/lib.rs'), ['epub', 'fileparse'])
  assert.deepEqual(select('crates/shared/src/lib.rs'), Object.keys(registered).sort())
  assert.deepEqual(select('runtime/unknown.rs'), Object.keys(registered).sort())
})

test('a manual ODT selection on main uses affected mode, not all faults', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./fault-reach.mjs', import.meta.url)), '--mode'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        ALL_FAULTS: 'false',
        DOCX_FAULTS: '',
        ODT_FAULTS: 'wire-root',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'affected')
})

for (const { name, event, ref, all = false, docx = '', odt = '', expected } of [
  { name: 'main push', event: 'push', ref: 'refs/heads/main', expected: 'all' },
  {
    name: 'main manual DOCX selection',
    event: 'workflow_dispatch',
    ref: 'refs/heads/main',
    docx: 'tools/docx-diff/faults-b4.json',
    expected: 'affected',
  },
  {
    name: 'main empty manual run',
    event: 'workflow_dispatch',
    ref: 'refs/heads/main',
    expected: 'all',
  },
  {
    name: 'branch default',
    event: 'workflow_dispatch',
    ref: 'refs/heads/feat/example',
    expected: 'affected',
  },
  {
    name: 'branch explicit all',
    event: 'workflow_dispatch',
    ref: 'refs/heads/feat/example',
    all: true,
    expected: 'all',
  },
]) {
  test(`fault mode for ${name}`, () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fault-reach.mjs', import.meta.url)), '--mode'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          ALL_FAULTS: String(all),
          DOCX_FAULTS: docx,
          ODT_FAULTS: odt,
        },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), expected)
  })
}

for (const selection of ['DOCX_FAULTS', 'ODT_FAULTS']) {
  test(`explicit all faults rejects a targeted ${selection} selection`, () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./fault-reach.mjs', import.meta.url)), '--mode'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          ALL_FAULTS: 'true',
          DOCX_FAULTS: '',
          ODT_FAULTS: '',
          [selection]: 'target',
        },
      },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /all faults cannot be combined with a targeted fault selection/)
  })
}
