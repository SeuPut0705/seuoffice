import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import init, { HwpDocument } from '@rhwp/core'
import { beforeAll, expect, it, vi } from 'vitest'
import { createHwpSkill } from '../../../apps/hwp/src/renderer/ai/hwp-skill'
import type { AgentBridge } from '../../../apps/hwp/src/renderer/ai/agent-bridge'
import { run, tempDir } from './helpers'

beforeAll(async () => {
  await init({
    module_or_path: readFileSync(createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')),
  })
})

function skill() {
  const readTable = vi.fn(async () => ({
    ok: true,
    table: 1,
    rows: 2,
    cols: 1,
    cells: [{ row: 2, col: 1, text: 'Second row' }],
  }))
  const { skill } = createHwpSkill({
    bridge: { readTable } as unknown as AgentBridge,
    label: (key) => key,
    onChange: () => {},
    imageGenAvailable: () => false,
    confirmMemoRemoval: async () => false,
  })
  return {
    readTable,
    call: (input: Record<string, unknown>) =>
      skill.executeTool({ id: '1', name: 'read_table', input }),
  }
}

for (const from_row of [0, -1, 1.5, '2', null, true]) {
  it(`refuses an explicit invalid row ${JSON.stringify(from_row)} before reading`, async () => {
    const { call, readTable } = skill()
    const result = await call({ table: 1, from_row })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('from_row')
    expect(readTable).not.toHaveBeenCalled()
  })
}

for (const from_row of [undefined, 1, 2]) {
  it(`passes a valid row ${from_row} to the bridge`, async () => {
    const { call, readTable } = skill()
    const result = await call({ table: 1, ...(from_row === undefined ? {} : { from_row }) })
    expect(result.isError).toBeUndefined()
    expect(readTable).toHaveBeenCalledWith(1, from_row ?? null)
  })
}

for (const format of ['hwp', 'hwpx']) {
  it(`reads the requested ${format} table row and rejects a negative row`, async () => {
    const dir = tempDir()
    const doc = HwpDocument.createEmpty()
    doc.createBlankDocument()
    doc.pasteHtml(0, 0, 0, '<table><tr><td>First row</td></tr><tr><td>Second row</td></tr></table>')
    const input = join(dir, 'form.' + format)
    const original = Buffer.from(format === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
    doc.free()
    writeFileSync(input, original)
    const ops = join(dir, 'ops.json')
    writeFileSync(ops, JSON.stringify([{ op: 'read_table', table: 1, from_row: 2 }]))
    const good = await run(['hwp', 'apply', input, '--ops', ops, '--json'])
    expect(good.code, good.stdout).toBe(0)
    expect(good.json().detail.results[0].output).toContain('Second row')
    expect(good.json().detail.results[0].output).not.toContain('First row')
    writeFileSync(ops, JSON.stringify([{ op: 'read_table', table: 1, from_row: -1 }]))
    const bad = await run(['hwp', 'apply', input, '--ops', ops, '--json'])
    expect(bad.code, bad.stdout).toBe(1)
    expect(bad.json().detail.failures[0].error).toContain('from_row')
    expect(readFileSync(input)).toEqual(original)
  })
}
