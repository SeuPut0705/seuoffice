/**
 * Local-only sanity run over real ODT files. Skipped unless ODT_CORPUS points at
 * a folder of `.odt` files (searched one level deep). Real files never enter
 * the repository; they may contain personal data.
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @seuoffice/odt-engine
 *
 * Every file opens with `odtToDocx`, and every range the bridge map records
 * (blocks, paragraphs, inline markers, table rows and cells) slices the
 * original part to a complete element.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { odtToBridge } from './helpers/bridge'
import type { TableExt } from './helpers/bridge-ext'

const root = process.env.ODT_CORPUS

function corpusFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      // generated outputs (out-docx2odt …) are not received files
      if (name.startsWith('out-')) continue
      for (const inner of readdirSync(path)) {
        if (inner.toLowerCase().endsWith('.odt')) out.push(join(path, inner))
      }
    } else if (name.toLowerCase().endsWith('.odt')) out.push(path)
  }
  return out.sort()
}

describe.skipIf(!root)('real ODT corpus (ODT_CORPUS)', () => {
  it('opens every file and every recorded range slices to its element', async () => {
    const files = corpusFiles(root as string)
    expect(files.length).toBeGreaterThan(0)
    const failures: string[] = []
    let opened = 0
    let ranges = 0
    const fail = (message: string) => {
      if (failures.length < 50) failures.push(message)
    }
    for (const file of files) {
      try {
        const bridge = await odtToBridge(new Uint8Array(readFileSync(file)))
        const part = (name: string) =>
          name === 'content.xml' ? bridge.content : (bridge.styles ?? '')
        const complete = (xml: string, tag: string) =>
          xml.startsWith(`<${tag}`) &&
          /[\s/>]/.test(xml.charAt(tag.length + 1)) &&
          (xml.endsWith('/>') || xml.endsWith(`</${tag}>`))

        let previousEnd = -1
        for (const block of bridge.map.blocks.filter((b) => b.parent === null)) {
          ranges++
          const text = part(block.part).slice(block.start, block.end)
          if (block.kind !== 'opaque' && !complete(text, block.name))
            fail(`${file}: bad range for block ${block.name}@${block.start}`)
          if (block.start < previousEnd) fail(`${file}: blocks overlap at ${block.start}`)
          else if (
            previousEnd >= 0 &&
            part(block.part).slice(previousEnd, block.start).trim() !== ''
          )
            fail(`${file}: non-blank gap before block at ${block.start}`)
          previousEnd = block.end
        }
        for (const p of bridge.map.paragraphs) {
          ranges++
          if (!complete(part(p.part).slice(p.start, p.end), p.element))
            fail(`${file}: bad range for paragraph ${p.id}`)
          for (const m of p.markers) {
            if (m.kind === 'bookmark-start' || m.kind === 'bookmark-end' || m.kind === 'bookmark') {
              const text = part(p.part).slice(m.start, m.end)
              if (!text.startsWith('<text:bookmark')) fail(`${file}: bad bookmark range in ${p.id}`)
            }
          }
        }
        const table = bridge.map.ext.table as unknown as TableExt | undefined
        for (const t of table?.tables ?? []) {
          ranges++
          if (!complete(bridge.content.slice(t.start, t.end), 'table:table'))
            fail(`${file}: bad range for table ${t.id}`)
          for (const row of t.rows)
            if (!complete(bridge.content.slice(row.start, row.end), 'table:table-row'))
              fail(`${file}: bad row range in table ${t.id}`)
          for (const cells of t.cells)
            for (const cell of cells) {
              if (cell.kind === 'filler') continue
              const tag = cell.kind === 'cell' ? 'table:table-cell' : 'table:covered-table-cell'
              if (!complete(bridge.content.slice(cell.start, cell.end), tag))
                fail(`${file}: bad cell range in table ${t.id}`)
            }
        }
        if (bridge.map.generator === null) fail(`${file}: no generator`)
        opened++
      } catch (err) {
        fail(`${file}: threw ${(err as Error).message}`)
      }
    }
    console.log(
      `corpus: opened ${opened}/${files.length}, ranges ${ranges}, failures ${failures.length}`,
    )
    expect(failures).toEqual([])
  }, 600_000)
})
