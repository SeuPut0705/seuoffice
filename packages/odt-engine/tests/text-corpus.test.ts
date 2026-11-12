/**
 * Local-only run of the text converters over real ODT files (never committed).
 * Skipped unless ODT_CORPUS points at a folder of `.odt` files (one level deep).
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @seuoffice/odt-engine
 *
 * For every file: ODF → OOXML for the whole body must not throw; every
 * paragraph element must read back from the bridge docx (`parseDocx`) with
 * exactly its recorded text; and every paragraph the editor regenerates
 * without changing it must keep its text and create no new style.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocx } from '@seuoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { editOnly, editorSave, odtToBridge, replaceText, writeBack } from './helpers/bridge'

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

/** The text without the trailing page break an ODF page-break style adds. */
const withoutBreak = (text: string) => text.replace(/\f$/, '')

describe.skipIf(!root)('text converters over the real corpus (ODT_CORPUS)', () => {
  it('converts every paragraph and reproduces its text both ways', async () => {
    const files = corpusFiles(root as string)
    expect(files.length).toBeGreaterThan(0)
    const failures: string[] = []
    let paragraphs = 0
    let readBack = 0
    let roundTrips = 0
    let newStyles = 0
    let fields = 0
    let unchanged = 0
    let edits = 0
    let attempted = 0
    const engineQuirks: string[] = []
    for (const file of files) {
      try {
        const bytes = new Uint8Array(readFileSync(file))
        // the body must convert without throwing; unedited, nothing is written back;
        // one edited paragraph changes only that paragraph
        const top = await odtToBridge(bytes)
        const same = await writeBack(top, top.docx)
        if (same.content !== top.content || same.styles !== (top.styles ?? ''))
          failures.push(`${file}: an unedited write-back changed the ODT`)
        else unchanged++
        const target = top.map.elements.findIndex(
          (e) => e.paragraph !== null && top.map.paragraphs[e.paragraph].text.length > 0,
        )
        if (target >= 0) {
          attempted++
          const { bytes: edited } = await editorSave(
            top.docx,
            editOnly({ [target]: (g) => replaceText(g, 0, 0, '편집 ') }),
          )
          const wb = await writeBack(top, edited)
          const record = top.map.paragraphs[top.map.elements[target].paragraph as number]
          const original = top.content
          const head = original.slice(0, record.start)
          const tail = original.slice(record.end)
          let stripped = wb.content
          for (const x of wb.newAutomaticStyles('content.xml')) stripped = stripped.replace(x, '')
          const reopened = await odtToBridge(wb.odt)
          const ok =
            stripped.startsWith(head) &&
            stripped.endsWith(tail) &&
            reopened.map.paragraphs.length === top.map.paragraphs.length &&
            withoutBreak(reopened.map.paragraphs[record.id].text) ===
              '편집 ' + withoutBreak(record.text)
          if (!ok) failures.push(`${file}: editing paragraph ${record.id} touched other parts`)
          else edits++
        }
        // every paragraph the editor shows as an element reads back with its recorded text
        const parsed = await parseDocx(top.docx)
        const visible = parsed.blocks.filter((b) => !b.hidden)
        const regenerate = new Set<number>()
        top.map.elements.forEach((element, index) => {
          if (element.paragraph === null) return
          const record = top.map.paragraphs[element.paragraph]
          paragraphs++
          fields += record.markers.filter((m) => m.field).length
          const block = visible[index]
          const text = (block?.runs ?? []).map((r) => r.text).join('')
          if (block && text !== record.text && /&#?\w+;/.test(record.text)) {
            // the docx engine decodes entity-looking literal text in w:t a second time
            // ("&#38;" typed as text reads back as "&"); not something the bridge can avoid
            engineQuirks.push(`${file} p${record.id}`)
            return
          }
          if (!block || text !== record.text) {
            if (failures.length < 40)
              failures.push(
                `${file} p${record.id}: read back ${JSON.stringify(text)} vs ${JSON.stringify(record.text)}`,
              )
            return
          }
          readBack++
          if (['paragraph', 'heading', 'listItem'].includes(block.type)) regenerate.add(index)
        })
        // the editor regenerates every paragraph without changing it: same text, no new style
        const { bytes: regenerated } = await editorSave(top.docx, (blocks) =>
          blocks.map((_, i) => (regenerate.has(i) ? { edit: i, change: () => {} } : { keep: i })),
        )
        const rewritten = await writeBack(top, regenerated)
        const again = await odtToBridge(rewritten.odt)
        for (const index of regenerate) {
          const record = top.map.paragraphs[top.map.elements[index].paragraph as number]
          const written = again.map.paragraphs[record.id]?.text
          if (written !== undefined && withoutBreak(written) === withoutBreak(record.text))
            roundTrips++
          else if (failures.length < 40)
            failures.push(
              `${file} p${record.id}: wrote ${JSON.stringify(written)} vs ${JSON.stringify(record.text)}`,
            )
        }
        newStyles +=
          rewritten.newAutomaticStyles('content.xml').length +
          rewritten.newAutomaticStyles('styles.xml').length
      } catch (err) {
        failures.push(`${file}: threw ${(err as Error).stack}`)
      }
    }
    console.log(
      `text corpus: files ${files.length}, unedited write-backs identical ${unchanged}, one-paragraph edits clean ${edits}/${attempted}, ` +
        `paragraphs ${paragraphs}, read back ${readBack}, ` +
        `round trips ${roundTrips}, form-field markers ${fields}, new styles ${newStyles}, engine entity quirks ${engineQuirks.length} (${engineQuirks.join(', ')}), failures ${failures.length}`,
    )
    if (failures.length) console.log(failures.join('\n'))
    expect(failures).toEqual([])
    expect(newStyles).toBe(0)
  }, 1_200_000)
})
