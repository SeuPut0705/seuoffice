// Types into a table cell of a received ODT the way the Word editor saves a cell-text edit:
// open through the public bridge (odtToDocx), patch the table's cell paragraph with the docx
// engine's `patchTableCellTexts` (what apps/docs `pmDocToSavePlan` does for text-only table
// edits), keep every other block as original, write back with saveOdt. The CLI's ops cannot
// type into an existing table cell (findReplace scans top-level paragraphs only), so cell
// edits go through the engines' public APIs.
//
//   node node_modules/tsx/dist/cli.mjs tools/odt-hancom/cell-edit.mts <in.odt> <out.odt> --append <text>
//   node node_modules/tsx/dist/cli.mjs tools/odt-hancom/cell-edit.mts <in.odt> <out.odt> --replace <find> <with>
//
// --append adds the text at the end of the first unlocked, non-empty cell paragraph;
// --replace replaces the first cell paragraph occurrence of <find> (unlocked cells only).
// Prints one JSON line: { status: "ok", block, row, tc, para, text } or { status: "skip", reason }.
import { readFileSync, writeFileSync } from 'node:fs'
import {
  type CellParaPatch,
  type Run,
  type SaveBlock,
  parseDocx,
  patchTableCellTexts,
  saveDocx,
} from '@genoffice/docx-engine'
import { isProtectedCell, odtToDocx, saveOdt } from '@genoffice/odt-engine'

const [input, output, mode, a, b] = process.argv.slice(2)
if (!input || !output || (mode !== '--append' && mode !== '--replace') || !a) {
  console.error('usage: cell-edit.mts <in.odt> <out.odt> --append <text> | --replace <find> <with>')
  process.exit(1)
}

/** Replaces [from, to) of the runs' text with insert, typed into the run at from. */
function editRuns(runs: Run[], from: number, to: number, insert: string): Run[] {
  let at = 0
  let inserted = false
  const out: Run[] = []
  for (const run of runs) {
    const start = at
    const end = at + run.text.length
    at = end
    let text = run.text
    const x = Math.max(from, start)
    const y = Math.min(to, end)
    if (y > x) text = text.slice(0, x - start) + text.slice(y - start)
    if (!inserted && from >= start && from <= end && !run.image) {
      const k = from - start
      text = text.slice(0, k) + insert + text.slice(k)
      inserted = true
    }
    if (text !== '' || run.image) out.push({ ...run, text })
  }
  if (!inserted) out.push({ text: insert })
  return out
}

const originalOdt = new Uint8Array(readFileSync(input))
const { docxBytes, bridge } = await odtToDocx(originalOdt)
const parsed = await parseDocx(docxBytes)
const blocks = parsed.blocks.filter((x) => !x.hidden)

/**
 * The cell's paragraphs patched the way the editor saves a text-only table edit; null when the
 * docx engine leaves the table as it was (a cell whose rich paragraphs also hold those of a
 * table nested in it cannot be addressed this way).
 */
function patched(
  blockIndex: number,
  row: number,
  tc: number,
  para: number,
  runs: Run[],
): string | null {
  const table = blocks[blockIndex]!
  const texts: Array<Array<CellParaPatch[] | null>> = table.table!.rows.map((r) =>
    r.map(() => null),
  )
  const paras: CellParaPatch[] = (table.table!.rows[row]![tc]!.richParas ?? []).map(() => null)
  paras[para] = { runs }
  texts[row]![tc] = paras
  const xml = patchTableCellTexts(table.originalXml as string, texts)
  return xml === table.originalXml ? null : xml
}

let found: {
  block: number
  row: number
  tc: number
  para: number
  xml: string
  text: string
} | null = null
// --append: a cell with text first; a form with only blank unlocked cells gets the text typed
// into the first blank one
search: for (const blank of mode === '--append' ? [false, true] : [false])
  for (const [bi, block] of blocks.entries()) {
    if (block.type !== 'table' || !block.table || typeof block.originalXml !== 'string') continue
    for (const [row, cells] of block.table.rows.entries()) {
      for (const [tc, cell] of cells.entries()) {
        if (isProtectedCell(bridge, { table: block.docxIndex as number, row, tc })) continue
        for (const [para, p] of (cell.richParas ?? []).entries()) {
          const runs = JSON.parse(JSON.stringify(p.runs ?? [])) as Run[]
          if (runs.some((r) => r.image)) continue
          const text = runs.map((r) => r.text).join('')
          let edited: Run[]
          if (mode === '--append') {
            if (!text.trim() !== blank) continue
            edited = editRuns(runs, text.length, text.length, a)
          } else {
            const at = text.indexOf(a)
            if (at < 0) continue
            edited = editRuns(runs, at, at + a.length, b ?? '')
          }
          const xml = patched(bi, row, tc, para, edited)
          if (!xml) continue
          found = { block: bi, row, tc, para, xml, text }
          break search
        }
      }
    }
  }
if (!found) {
  console.log(JSON.stringify({ status: 'skip', reason: 'no unlocked cell paragraph to edit' }))
  process.exit(0)
}
const xml = found.xml
const save: SaveBlock[] = blocks.map((x, i) =>
  i === found!.block
    ? { kind: 'xml', xml, docxIndex: x.docxIndex as number }
    : { kind: 'original', docxIndex: x.docxIndex as number },
)
const editedDocx = await saveDocx(parsed, save)
const saved = await saveOdt({ originalOdt, bridge, editedDocx })
writeFileSync(output, saved)
// saveOdt hands back the received bytes themselves when it wrote nothing
const changed = saved !== originalOdt
console.log(
  JSON.stringify({
    status: 'ok',
    block: found.block,
    row: found.row,
    tc: found.tc,
    para: found.para,
    text: found.text,
    changed,
  }),
)
