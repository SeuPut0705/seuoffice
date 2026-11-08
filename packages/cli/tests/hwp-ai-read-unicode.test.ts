import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import init, { HwpDocument } from '@rhwp/core'
import { beforeAll, expect, it } from 'vitest'
import { createHwpSkill, READ_PAGE_CHARS } from '../../../apps/hwp/src/renderer/ai/hwp-skill'
import type { AgentBridge } from '../../../apps/hwp/src/renderer/ai/agent-bridge'
import { run, tempDir } from './helpers'

beforeAll(async () => {
  await init({
    module_or_path: readFileSync(createRequire(import.meta.url).resolve('@rhwp/core/rhwp_bg.wasm')),
  })
})

function reader(text: string) {
  const { skill } = createHwpSkill({
    bridge: { readText: async () => text } as unknown as AgentBridge,
    label: (key) => key,
    onChange: () => {},
    imageGenAvailable: () => false,
    confirmMemoRemoval: async () => false,
  })
  return (offset?: number) =>
    skill.executeTool({
      id: '1',
      name: 'read_document',
      input: offset === undefined ? {} : { offset },
    })
}

function content(output: string) {
  return output
    .slice(output.indexOf('\n') + 1)
    .replace(/\n\[more: call read_document with offset \d+\]$/, '')
}

for (const character of ['😀', '𠀀']) {
  it(`keeps ${character} whole when it crosses the page limit`, async () => {
    const text = 'a'.repeat(READ_PAGE_CHARS - 1) + character + 'tail'
    const read = reader(text)
    const first = await read()
    const next = Number(/with offset (\d+)/.exec(first.output)![1])
    expect(next).toBe(READ_PAGE_CHARS - 1)
    const second = await read(next)
    expect(content(first.output).isWellFormed()).toBe(true)
    expect(content(second.output).startsWith(character)).toBe(true)
    expect(content(first.output) + content(second.output)).toBe(text)
    expect(first.mutated).toBeUndefined()
  })

  it(`refuses a requested offset inside ${character}`, async () => {
    const read = reader('a' + character + 'tail')
    const bad = await read(2)
    expect(bad.isError).toBe(true)
    expect(bad.output).toContain('offset')
    expect((await read(1)).output).toContain(character)
    expect((await read(3)).output.endsWith('tail')).toBe(true)
  })

  it(`keeps a pair ending exactly at the limit: ${character}`, async () => {
    const text = 'a'.repeat(READ_PAGE_CHARS - 2) + character + 'tail'
    const read = reader(text)
    const first = await read()
    expect(first.output).toContain(`with offset ${READ_PAGE_CHARS}`)
    expect(content(first.output)).toBe(text.slice(0, READ_PAGE_CHARS))
  })
}

it('keeps ASCII paging and end-of-document reads unchanged', async () => {
  const read = reader('a'.repeat(READ_PAGE_CHARS) + 'tail')
  expect((await read()).output).toContain(`with offset ${READ_PAGE_CHARS}`)
  expect(content((await read(READ_PAGE_CHARS)).output)).toBe('tail')
  expect(content((await read(READ_PAGE_CHARS + 4)).output)).toBe('')
})

for (const format of ['hwp', 'hwpx']) {
  it(`refuses a split pair through the ${format} CLI operation`, async () => {
    const dir = tempDir()
    const input = join(dir, 'form.' + format)
    const ops = join(dir, 'ops.json')
    const doc = HwpDocument.createEmpty()
    doc.createBlankDocument()
    doc.insertText(0, 0, 0, 'a😀tail')
    const original = Buffer.from(format === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
    doc.free()
    writeFileSync(input, original)
    writeFileSync(ops, JSON.stringify([{ op: 'read_document', offset: 2 }]))
    const r = await run(['hwp', 'apply', input, '--ops', ops, '--json'])
    expect(r.code, r.stdout).toBe(1)
    expect(r.json().detail.failures[0].error).toContain('surrogate pair')
    expect(readFileSync(input)).toEqual(original)
    writeFileSync(ops, JSON.stringify([{ op: 'read_document', offset: 1 }]))
    const good = await run(['hwp', 'apply', input, '--ops', ops, '--json'])
    expect(good.code, good.stdout).toBe(0)
    expect(good.json().detail.results[0].output).toContain('😀tail')
  })
}
