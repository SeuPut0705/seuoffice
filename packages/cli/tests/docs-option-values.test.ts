import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function fixture() {
  const dir = tempDir(),
    input = join(dir, 'source.docx'),
    ops = join(dir, 'ops.json'),
    bytes = Buffer.from(await buildBlankDocx())
  writeFileSync(input, bytes)
  writeFileSync(
    ops,
    JSON.stringify([{ op: 'insert_content', html: '<p>Trial text</p>', afterBlockIndex: -1 }]),
  )
  return { dir, input, ops, bytes }
}
for (const flag of ['range', 'max-chars', 'author'])
  it(`refuses a valueless read --${flag}`, async () => {
    const { input, bytes } = await fixture()
    const r = await run(['docs', 'read', input, '--' + flag, '--json'])
    expect(r.code, r.stdout).toBe(1)
    expect(r.json().error).toBe('missing_argument')
    expect(readFileSync(input)).toEqual(bytes)
  })
for (const flag of ['date', 'granularity', 'ignore', 'author'])
  it(`refuses a valueless compare --${flag}`, async () => {
    const { dir, input } = await fixture(),
      output = join(dir, 'result.docx')
    const r = await run(['docs', 'compare', input, input, '--out', output, '--' + flag, '--json'])
    expect(r.code, r.stdout).toBe(1)
    expect(r.json().error).toBe('missing_argument')
    expect(existsSync(output)).toBe(false)
  })
it('does not turn a valueless --out into an in-place edit', async () => {
  const { input, ops, bytes } = await fixture()
  const r = await run(['docs', 'apply', input, '--ops', ops, '--out', '--json'])
  expect(r.code, r.stdout).toBe(1)
  expect(r.json().error).toBe('missing_argument')
  expect(readFileSync(input)).toEqual(bytes)
})
it('keeps absent and explicit values working', async () => {
  const { input, ops } = await fixture()
  expect(
    (await run(['docs', 'read', input, '--range', '0', '--max-chars', '5', '--json'])).code,
  ).toBe(0)
  expect(
    (
      await run([
        'docs',
        'apply',
        input,
        '--ops',
        ops,
        '--dry-run',
        '--author',
        'Test Author',
        '--json',
      ])
    ).code,
  ).toBe(0)
})
