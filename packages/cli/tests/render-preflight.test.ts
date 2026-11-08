import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { PNG } from 'pngjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { run, tempDir } from './helpers'
const { render } = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../src/formats/render', async (original) => ({
  ...(await original<typeof import('../src/formats/render')>()),
  renderToPngs: render,
}))
vi.mock('../src/formats/pptx', async (original) => ({
  ...(await original<typeof import('../src/formats/pptx')>()),
  openDeck: async () => ({}),
  describeDeck: () => ({
    size: { cx: 2, cy: 2 },
    pages: [{ index: 0, elements: [{ id: 'e_1', box: { x: 0, y: 0, cx: 1, cy: 1 } }] }],
  }),
}))
beforeEach(() => {
  render.mockReset().mockImplementation(async (path, _ctx, options) => {
    mkdirSync(options.outDir, { recursive: true })
    const output = join(options.outDir, `${basename(path, extname(path))}-01.png`)
    const png = new PNG({ width: 80, height: 40 })
    png.data.fill(255)
    writeFileSync(output, PNG.sync.write(png))
    return [{ page: 0, path: output, width: 80, height: 40 }]
  })
})
async function fixture() {
  const dir = tempDir()
  const input = join(dir, 'deck.pptx')
  writeFileSync(input, 'fixture handled by the fake renderer')
  const out = join(dir, 'shots')
  mkdirSync(out)
  const existing = join(out, 'deck-01.png')
  const before = Buffer.from('keep the existing picture')
  writeFileSync(existing, before)
  return { input, out, existing, before }
}
describe('render validates active numeric options before writing pictures', () => {
  it.each(
    [
      ['--grid', '--cols', '0'],
      ['--grid', '--cols', 'bad'],
      ['--grid', '--tile', '0'],
      ['--grid', '--tile', '1.5'],
      ['--el', 'e_1', '--pad', '-1'],
      ['--el', 'e_1', '--pad', 'bad'],
    ].map((flags) => ({ flags })),
  )('rejects $flags before rendering', async ({ flags }) => {
    const { input, out, existing, before } = await fixture()
    const result = await run(['render', input, '--out', out, ...flags, '--json'])
    expect(result.code).toBe(1)
    expect(result.json().error).toBe('invalid_argument')
    expect(render).not.toHaveBeenCalled()
    expect(readFileSync(existing)).toEqual(before)
  })
  it.each(
    [
      ['--grid', '--cols', '2', '--tile', '16'],
      ['--el', 'e_1', '--pad', '0'],
      ['--cols', '0', '--tile', '0', '--pad', '-1'],
    ].map((flags) => ({ flags })),
  )('retains valid or inactive option behavior for $flags', async ({ flags }) => {
    const { input, out } = await fixture()
    const result = await run(['render', input, '--out', out, ...flags, '--json'])
    expect(result.code).toBe(0)
    expect(render).toHaveBeenCalledTimes(1)
  })
})
