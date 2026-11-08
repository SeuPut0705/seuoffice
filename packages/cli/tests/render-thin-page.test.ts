import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, rgb } from 'pdf-lib'
import { PNG } from 'pngjs'
import { expect, it } from 'vitest'
import { run, tempDir } from './helpers'
it('keeps a real thin PDF page visible in the rendered contact sheet', async () => {
  const dir = tempDir()
  const pdf = await PDFDocument.create()
  pdf.addPage([1000, 1]).drawRectangle({ x: 0, y: 0, width: 1000, height: 1, color: rgb(1, 0, 0) })
  const source = join(dir, 'thin.pdf')
  writeFileSync(source, await pdf.save())
  const before = readFileSync(source)
  const result = await run([
    'render',
    source,
    '--out',
    join(dir, 'shots'),
    '--grid',
    '--cols',
    '1',
    '--tile',
    '10',
    '--json',
  ])
  expect(result.code).toBe(0)
  const grid = result.json().detail.grid
  expect(grid.tiles[0].h).toBe(1)
  const png = PNG.sync.read(readFileSync(grid.path))
  const tile = grid.tiles[0]
  const offset = (tile.y * png.width + tile.x) * 4
  expect(Array.from(png.data.subarray(offset, offset + 4))).toEqual([255, 0, 0, 255])
  expect(readFileSync(source)).toEqual(before)
})
