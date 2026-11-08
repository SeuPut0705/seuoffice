/**
 * Local-only run of the public API over real ODT files (never committed).
 * Skipped unless ODT_CORPUS points at a folder of `.odt` files (one level deep).
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @genoffice/odt-engine
 *
 * For every file, through `odtToDocx` / the editor's save / `saveOdt`:
 * it opens; an unedited save returns the original bytes; one paragraph edit,
 * one cell edit and one margin edit each change only their part of the
 * package and, inside it, only their element (new automatic styles aside).
 * Open and save times of the largest file are printed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocx, readSections } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { odtToDocx, odtToText, saveOdt } from '../src'
import { readOdtPackage } from '../src/core'
import { readPageExt } from '../src/page'
import type { TableExt } from '../src/table'
import { diffPackages, expectedOrder, textOf } from './helpers/api'
import { editorSave, replaceText } from './helpers/bridge'
import { cellRuns, editRuns, patchCells } from './helpers/table-editor'

const root = process.env.ODT_CORPUS

function corpusFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      // generated outputs (out-docx2odt …) are not received files
      if (name.startsWith('out-')) continue
      for (const inner of readdirSync(path))
        if (inner.toLowerCase().endsWith('.odt')) out.push(join(path, inner))
    } else if (name.toLowerCase().endsWith('.odt')) out.push(path)
  }
  return out.sort()
}

/** The part with new automatic styles and font faces taken out. */
const withoutNewStyles = (xml: string) =>
  xml
    .replace(/<style:style style:name="[^"]*_io\d+"[^>]*?(?:\/>|>[\s\S]*?<\/style:style>)/g, '')
    .replace(/<style:page-layout style:name="[^"]*_io\d+"[\s\S]*?<\/style:page-layout>/g, '')

/** Only `[start, end)` of `before` differs in `after` (new automatic styles aside). */
function onlyRange(before: string, after: string, start: number, end: number): boolean {
  const stripped = withoutNewStyles(after)
  return stripped.startsWith(before.slice(0, start)) && stripped.endsWith(before.slice(end))
}

describe.skipIf(!root)('public API over the corpus', () => {
  it('opens, saves unedited byte for byte and keeps edits narrow', async () => {
    const files = corpusFiles(root as string)
    expect(files.length).toBeGreaterThan(0)
    const failures: string[] = []
    const totals = { files: 0, text: 0, unedited: 0, paragraph: 0, cell: 0, margin: 0 }
    let largest = { name: '', size: 0, open: 0, save: 0 }
    let largestContent = { name: '', size: 0, open: 0, save: 0 }
    for (const file of files) {
      const name = file.slice((root as string).length + 1)
      try {
        const odt = new Uint8Array(readFileSync(file))
        const t0 = performance.now()
        const { docxBytes, bridge } = await odtToDocx(odt)
        const t1 = performance.now()
        totals.files++
        // plain text never throws for content reasons (picture-only files have none)
        await odtToText(odt)
        totals.text++
        const keep = await editorSave(docxBytes, (blocks) => blocks.map((_, i) => ({ keep: i })))
        const t2 = performance.now()
        const same = await saveOdt({ originalOdt: odt, bridge, editedDocx: keep.bytes })
        const t3 = performance.now()
        if (odt.length > largest.size)
          largest = { name, size: odt.length, open: t1 - t0, save: t3 - t2 }
        if (same.length === odt.length && same.every((b, i) => b === odt[i])) totals.unedited++
        else failures.push(`${name}: unedited save changed the bytes`)

        const pkg = await readOdtPackage(odt)
        const contentSize = pkg.get('content.xml')?.bytes.length ?? 0
        if (contentSize > largestContent.size)
          largestContent = { name, size: contentSize, open: t1 - t0, save: t3 - t2 }
        const content = textOf(pkg, 'content.xml')
        const parsed = await parseDocx(docxBytes)
        const visible = parsed.blocks.filter((b) => !b.hidden)
        const order = await expectedOrder(odt)

        // 1. one top-level paragraph with text
        const record = bridge.paragraphs.find((p) => {
          if (!p || p.part !== 'content.xml' || !p.text.trim() || p.list) return false
          const block = p.block !== null ? bridge.blocks[p.block] : null
          return (
            !!block &&
            block.owner === 'text' &&
            block.parent === null &&
            !p.markers.some((m) => m.kind === 'handler')
          )
        })
        const pIndex = record
          ? visible.findIndex((b) => b.hiddenBookmarks?.includes(`_odtp${record.id}`))
          : -1
        if (record && pIndex >= 0) {
          const { bytes } = await editorSave(docxBytes, (blocks) =>
            blocks.map((_, i) =>
              i === pIndex
                ? {
                    edit: i,
                    change: (g) => replaceText(g, record.text.length, record.text.length, ' 고침'),
                  }
                : { keep: i },
            ),
          )
          const saved = await saveOdt({ originalOdt: odt, bridge, editedDocx: bytes })
          const diff = await diffPackages(odt, saved)
          const after = textOf(await readOdtPackage(saved), 'content.xml')
          if (diff.changed.join() !== 'content.xml' || diff.added.length || diff.removed.length)
            failures.push(`${name}: paragraph edit changed ${diff.changed.join(', ')}`)
          else if (
            diff.order.join() !== order.join() ||
            !diff.mimetypeFirst ||
            !diff.mimetypeStored
          )
            failures.push(`${name}: paragraph edit re-packed out of order`)
          else if (!onlyRange(content, after, record.start, record.end))
            failures.push(`${name}: paragraph edit changed more than its paragraph`)
          else if (!after.includes('고침')) failures.push(`${name}: paragraph edit not written`)
          else totals.paragraph++
        }

        // 2. one unlocked cell with text in a top-level table
        const ext = bridge.ext.table as unknown as TableExt | undefined
        let cellDone = false
        for (const [elementId, tableId] of Object.entries(ext?.elements ?? {})) {
          if (cellDone) break
          const rec = ext?.tables[tableId]
          if (!rec || rec.structureLocked) continue
          const element = bridge.elements[Number(elementId)]
          const block = visible.find((b) => b.type === 'table' && b.originalXml === element.xml)
          if (!block?.table) continue
          for (let r = 0; r < rec.cells.length && !cellDone; r++) {
            for (const cell of rec.cells[r]) {
              if (cell.kind !== 'cell' || cell.protected || cell.tc === null) continue
              const unit = cell.units[0]
              const para = unit?.kind === 'p' ? bridge.paragraphs[unit.paragraph] : null
              if (!para?.text.trim() || cell.units.length !== 1) continue
              if (para.markers.some((m) => m.kind === 'handler')) continue
              const runs = cellRuns(block, r, cell.tc, 0)
              const text = runs.map((x) => x.text).join('')
              if (text !== para.text) continue
              const { bytes } = await editorSave(docxBytes, (blocks) =>
                blocks.map((b, i) =>
                  b.docxIndex === block.docxIndex
                    ? patchCells(b, [
                        {
                          row: r,
                          tc: cell.tc as number,
                          paras: [{ runs: editRuns(runs, text.length, text.length, ' 고침') }],
                        },
                      ])
                    : { keep: i },
                ),
              )
              const saved = await saveOdt({ originalOdt: odt, bridge, editedDocx: bytes })
              const diff = await diffPackages(odt, saved)
              const after = textOf(await readOdtPackage(saved), 'content.xml')
              if (diff.changed.join() !== 'content.xml' || diff.added.length)
                failures.push(`${name}: cell edit changed ${diff.changed.join(', ')}`)
              else if (!onlyRange(content, after, cell.start, cell.end))
                failures.push(`${name}: cell edit changed more than its cell`)
              else if (!after.includes('고침')) failures.push(`${name}: cell edit not written`)
              else totals.cell++
              cellDone = true
              break
            }
          }
        }

        // 3. the final section's left margin
        const page = readPageExt(bridge)
        const sections = readSections(parsed)
        const last = sections[sections.length - 1]
        const run = page ? page.runs[page.sections[page.sections.length - 1].run] : null
        const used = (page?.runs ?? []).filter((x) => x.master === run?.master).length
        const layout = run?.layout ? pkg && (await odtToLayout(odt, run.layout)) : null
        if (last && run && layout && used === 1) {
          const { bytes } = await editorSave(
            docxBytes,
            (blocks) => blocks.map((_, i) => ({ keep: i })),
            { section: { ...last.settings, marginLeft: last.settings.marginLeft + 567 } },
          )
          const saved = await saveOdt({ originalOdt: odt, bridge, editedDocx: bytes })
          const diff = await diffPackages(odt, saved)
          const styles = textOf(pkg, 'styles.xml')
          const after = textOf(await readOdtPackage(saved), 'styles.xml')
          if (diff.changed.join() !== 'styles.xml' || diff.added.length)
            failures.push(`${name}: margin edit changed ${diff.changed.join(', ')}`)
          else if (!onlyRange(styles, after, layout.start, layout.end))
            failures.push(`${name}: margin edit changed more than its page layout`)
          else totals.margin++
        }
      } catch (e) {
        failures.push(`${name}: ${(e as Error).stack ?? (e as Error).message}`)
      }
    }
    console.log(`api corpus: ${JSON.stringify(totals)}`)
    console.log(
      `largest: ${largest.name} (${(largest.size / 1024 / 1024).toFixed(1)} MB): ` +
        `open ${largest.open.toFixed(0)} ms, unedited save ${largest.save.toFixed(0)} ms; ` +
        `largest content.xml: ${largestContent.name} (${(largestContent.size / 1024 / 1024).toFixed(1)} MB): ` +
        `open ${largestContent.open.toFixed(0)} ms, unedited save ${largestContent.save.toFixed(0)} ms`,
    )
    expect(failures).toEqual([])
    expect(totals.unedited).toBe(totals.files)
  }, 1_200_000)
})

/** The source range of a page layout of the ODT's styles.xml. */
async function odtToLayout(
  odt: Uint8Array,
  name: string,
): Promise<{ start: number; end: number } | null> {
  const { openOdt } = await import('../src/core')
  const doc = await openOdt(odt)
  const layout = doc.styles.pageLayout(name)
  return layout ? { start: layout.start, end: layout.end } : null
}
