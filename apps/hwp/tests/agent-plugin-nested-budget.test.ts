/**
 * listTables against the real rhwp engine on a long document: a table of a few thousand
 * cells before a form with tables inside its cells (fixtures/nested-form.hwp). The lookup
 * budget for tables inside cells used to run out in the big table, so the form's inner
 * tables went missing and the list said `partial`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { agentPlugin, type AgentPluginHost } from '../studio-plugin/agent-plugin.mjs'

const require = createRequire(import.meta.url)

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

const NESTED_FORM = readFileSync(join(__dirname, 'fixtures', 'nested-form.hwp'))

function plugin(doc: HwpDocument) {
  const host = {
    read: (fn: (d: HwpDocument) => unknown) => fn(doc),
    transaction: (_label: string, fn: (tx: unknown) => unknown) =>
      fn({ doc: () => doc, deferPagination: () => {} }),
    events: { on: () => {} },
    automation: { execute: () => null },
  }
  return agentPlugin.activate(host as unknown as AgentPluginHost)
}

describe('listTables on a long document', () => {
  it('finds the tables inside cells after a table of 6,900 cells', () => {
    const doc = new HwpDocument(new Uint8Array(NESTED_FORM))
    const alone = plugin(doc).listTables()
    const rows = Array.from({ length: 2300 }, (_, i) => `<tr><td>${i}</td><td></td><td></td></tr>`)
    expect(JSON.parse(doc.pasteHtml(0, 0, 0, `<table>${rows.join('')}</table>`)).ok).toBe(true)

    const listed = plugin(doc).listTables()
    expect(listed.partial).toBe(false)
    expect(listed.count).toBe(alone.count + 1)
    expect(listed.tables[0].rows).toBe(2300)
    expect(listed.tables.filter((t: { inTable?: number }) => t.inTable).length).toBe(
      alone.tables.filter((t: { inTable?: number }) => t.inTable).length,
    )
  }, 30000)
})
