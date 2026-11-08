import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { expect, it } from 'vitest'
import { run, tempDir } from './helpers'

async function fixture() {
  const dir = tempDir(),
    input = join(dir, 'source.docx'),
    ops = join(dir, 'ops.json')
  const bytes = Buffer.from(await buildBlankDocx())
  writeFileSync(input, bytes)
  writeFileSync(
    ops,
    JSON.stringify([{ op: 'insert_content', html: '<p>Trial text</p>', afterBlockIndex: -1 }]),
  )
  return { dir, input, ops, bytes }
}
for (const ext of ['hwp', 'hwpx', 'pdf', 'txt', 'odt']) {
  it(`refuses a .${ext} output without replacing an existing file`, async () => {
    const { dir, input, ops, bytes } = await fixture(),
      output = join(dir, 'result.' + ext)
    writeFileSync(output, 'keep existing output')
    const r = await run([
      'docs',
      'apply',
      input,
      '--ops',
      ops,
      '--out',
      output,
      '--force',
      '--json',
    ])
    expect(r.code, r.stdout).toBe(1)
    expect(r.json().error).toBe('invalid_argument')
    expect(readFileSync(input)).toEqual(bytes)
    expect(readFileSync(output, 'utf8')).toBe('keep existing output')
  })
}
for (const separate of [false, true]) {
  it(`keeps a same-format ${separate ? 'named' : 'in-place'} edit working`, async () => {
    const { dir, input, ops } = await fixture(),
      output = join(dir, 'result.DOCX')
    const r = await run([
      'docs',
      'apply',
      input,
      '--ops',
      ops,
      ...(separate ? ['--out', output] : []),
      '--json',
    ])
    expect(r.code, r.stdout).toBe(0)
    expect(
      readFileSync(separate ? output : input)
        .subarray(0, 2)
        .toString(),
    ).toBe('PK')
  })
}
it('also validates the output format before a dry run', async () => {
  const { dir, input, ops } = await fixture()
  const r = await run([
    'docs',
    'apply',
    input,
    '--ops',
    ops,
    '--out',
    join(dir, 'result.hwp'),
    '--dry-run',
    '--json',
  ])
  expect(r.code, r.stdout).toBe(1)
  expect(r.json().error).toBe('invalid_argument')
})
