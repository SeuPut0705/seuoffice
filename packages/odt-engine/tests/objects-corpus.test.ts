/**
 * Local-only run of the objects layer over real ODT files (never committed).
 * Skipped unless ODT_CORPUS points at a folder of `.odt` files (one level deep).
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @seuoffice/odt-engine
 *
 * For every file: conversion must not throw; every
 * picture, placeholder, note and comment reaches the bridge docx; paragraphs
 * holding objects read back with their recorded text; an unedited save writes
 * nothing and changes no package entry; editing every paragraph that holds an
 * object keeps every object, in the body and in table cells; editing a note's
 * text rewrites only its paragraph. Counts per kind are printed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Run, parseDocx } from '@seuoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { type ObjectsExt, odtToDocx } from '../src'
import { editOnly, editorSave, odtToBridge, replaceText, writeBack } from './helpers/bridge'
import type { TableExt } from './helpers/bridge-ext'
import { visibleBlocks } from './helpers/objects-fixtures'
import { cellRuns, editRuns, patchCells } from './helpers/table-editor'

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

const OBJECT_TAGS = [
  '<draw:frame ',
  '<draw:g ',
  '<draw:rect ',
  '<draw:custom-shape ',
  '<draw:polygon ',
  '<text:note ',
  '<office:annotation ',
  '<office:annotation-end ',
]
const count = (xml: string, tag: string) => xml.split(tag).length - 1

/** The saved ODT opens again with as many pictures, placeholders, notes and comments. */
async function sameObjects(odt: Uint8Array, before: ObjectsExt): Promise<boolean> {
  const { bridge } = await odtToDocx(odt)
  const after = (bridge.ext.objects ?? {
    pictures: [],
    placeholders: [],
    notes: [],
    comments: [],
  }) as unknown as ObjectsExt
  return (
    after.pictures.length === before.pictures.length &&
    after.placeholders.length === before.placeholders.length &&
    after.notes.length === before.notes.length &&
    after.comments.length === before.comments.length
  )
}

describe.skipIf(!root)('objects layer over the real corpus (ODT_CORPUS)', () => {
  it('converts every object and writes it back unchanged', async () => {
    const files = corpusFiles(root as string)
    expect(files.length).toBeGreaterThan(0)
    const failures: string[] = []
    const kinds: Record<string, number> = {}
    let pictures = 0
    let previews = 0
    let footnotes = 0
    let endnotes = 0
    let comments = 0
    let unchanged = 0
    let edited = 0
    let noteEdits = 0
    for (const file of files) {
      const name = file.split(/[\\/]/).pop()
      try {
        const bytes = new Uint8Array(readFileSync(file))
        const bridge = await odtToBridge(bytes)
        const ext = (bridge.map.ext.objects ?? {
          placeholders: [],
          pictures: [],
          notes: [],
          comments: [],
        }) as unknown as ObjectsExt
        pictures += ext.pictures.length
        for (const p of ext.placeholders) {
          kinds[p.kind] = (kinds[p.kind] ?? 0) + 1
          if (p.preview) previews++
        }
        footnotes += ext.notes.filter((n) => n.kind === 'footnote').length
        endnotes += ext.notes.filter((n) => n.kind === 'endnote').length
        comments += ext.comments.length

        // everything reached the bridge docx
        const { parsed, blocks } = await visibleBlocks(bridge.docx)
        const names = new Set(
          blocks.flatMap((b) =>
            [...(b.originalXml ?? '').matchAll(/<wp:docPr [^>]*name="([^"]*)"/g)].map((m) => m[1]),
          ),
        )
        for (const o of [...ext.pictures, ...ext.placeholders])
          if (!names.has(o.name))
            failures.push(`${name}: ${o.name} is missing from the bridge docx`)
        if (parsed.footnotes.length !== ext.notes.filter((n) => n.kind === 'footnote').length)
          failures.push(`${name}: footnotes ${parsed.footnotes.length} vs ${ext.notes.length}`)
        if (parsed.comments.length !== ext.comments.length)
          failures.push(`${name}: comments ${parsed.comments.length} vs ${ext.comments.length}`)
        for (const n of ext.notes) {
          const list = n.kind === 'footnote' ? parsed.footnotes : parsed.endnotes
          if (list.find((x) => x.id === n.id)?.text !== n.text)
            failures.push(`${name}: note ${n.kind} ${n.id} reads back differently`)
        }
        const byIndex = new Map(parsed.blocks.map((b) => [b.docxIndex, b]))
        const withObjects: number[] = []
        bridge.map.elements.forEach((e, i) => {
          if (e.paragraph === null) return
          const record = bridge.map.paragraphs[e.paragraph]
          if (!record.markers.some((m) => m.owner === 'objects')) return
          const block = byIndex.get(e.id)
          if (!block || block.type === 'image' || block.type === 'passthrough') return
          const text = (block.runs ?? []).map((r) => r.text).join('')
          if (text !== record.text)
            failures.push(
              `${name} p${record.id}: read back ${JSON.stringify(text)} vs ${JSON.stringify(record.text)}`,
            )
          else if (block.type === 'paragraph' || block.type === 'listItem') withObjects.push(i)
        })

        // unedited: nothing written, no package change
        const same = await editorSave(bridge.docx, (bs) => bs.map((_, i) => ({ keep: i })))
        const wb0 = await writeBack(bridge, same.bytes)
        if (
          wb0.content !== bridge.content ||
          wb0.changes.add.length ||
          wb0.changes.remove.length ||
          wb0.manifest !== (bridge.archive.text('META-INF/manifest.xml') ?? '')
        )
          failures.push(`${name}: an unedited save changed the ODT`)
        else unchanged++

        // every paragraph holding an object, edited: every object survives
        if (withObjects.length) {
          const visibleIndex = new Map(blocks.map((b, i) => [b.docxIndex, i]))
          const edits: Record<number, (g: Parameters<typeof replaceText>[0]) => void> = {}
          for (const i of withObjects) {
            const v = visibleIndex.get(i)
            if (v !== undefined) edits[v] = (g) => replaceText(g, 0, 0, 'X')
          }
          const { bytes: changed } = await editorSave(bridge.docx, editOnly(edits))
          const wb = await writeBack(bridge, changed)
          const lost = OBJECT_TAGS.filter((t) => count(wb.content, t) !== count(bridge.content, t))
          if (lost.length) failures.push(`${name}: editing changed the count of ${lost.join(', ')}`)
          else if (wb.changes.add.length || wb.changes.remove.length)
            failures.push(`${name}: editing text changed package entries`)
          else if (!(await sameObjects(wb.odt, ext)))
            failures.push(`${name}: the edited ODT reads back with different objects`)
          else edited++
        }

        // a note's text edited in the editor: only its paragraph changes
        const note = ext.notes.find((n) => n.kind === 'footnote' && n.editable && n.text)
        if (note) {
          const notes = parsed.footnotes.map((n) =>
            n.id === note.id ? { id: n.id, text: `${n.text} 고침` } : { id: n.id, text: n.text },
          )
          const { bytes: changed } = await editorSave(
            bridge.docx,
            (bs) => bs.map((_, i) => ({ keep: i })),
            { footnotes: notes },
          )
          const wb = await writeBack(bridge, changed)
          const host = bridge.map.paragraphs[note.paragraph]
          const original = bridge.content
          let stripped = wb.content
          for (const x of wb.newAutomaticStyles('content.xml')) stripped = stripped.replace(x, '')
          const ok =
            stripped.startsWith(original.slice(0, host.start)) &&
            stripped.endsWith(original.slice(host.end)) &&
            stripped.includes('고침</text:span></text:p></text:note-body>') &&
            count(stripped, '<text:note ') === count(original, '<text:note ')
          if (!ok) failures.push(`${name}: editing note ${note.id} touched other parts`)
          else noteEdits++
        }
      } catch (err) {
        failures.push(`${name}: threw ${(err as Error).stack}`)
      }
    }
    console.log(
      `objects corpus: files ${files.length}, pictures ${pictures}, placeholders ${JSON.stringify(kinds)} ` +
        `(with preview ${previews}), footnotes ${footnotes}, endnotes ${endnotes}, comments ${comments}, ` +
        `unedited saves identical ${unchanged}, object paragraphs edited cleanly in ${edited} files, ` +
        `note edits clean ${noteEdits}, failures ${failures.length}`,
    )
    if (failures.length) console.log(failures.slice(0, 60).join('\n'))
    expect(failures).toEqual([])
  }, 1_200_000)

  it('keeps the objects of every table cell when the cell text is edited', async () => {
    const files = corpusFiles(root as string)
    const failures: string[] = []
    let cells = 0
    let withObjects = 0
    let kept = 0
    for (const file of files) {
      const name = file.split(/[\\/]/).pop()
      try {
        const bridge = await odtToBridge(new Uint8Array(readFileSync(file)))
        const table = bridge.map.ext.table as unknown as TableExt | undefined
        if (!table) continue
        const parsed = await parseDocx(bridge.docx)
        const visible = parsed.blocks.filter((b) => !b.hidden)
        for (const [elementId, tableId] of Object.entries(table.elements)) {
          const record = table.tables[tableId]
          const block = visible.findIndex(
            (b) =>
              b.type === 'table' && b.originalXml === bridge.map.elements[Number(elementId)].xml,
          )
          if (block < 0) continue
          // the first paragraph of every unlocked cell that holds an object gets a letter in front
          const edits: Array<{ row: number; tc: number; paras: Array<{ runs: Run[] } | null> }> = []
          record.cells.forEach((cellRow, row) =>
            cellRow.forEach((cell) => {
              if (cell.kind !== 'cell' || cell.protected) return
              const paragraphs = cell.units.flatMap((u) => (u.kind === 'p' ? [u.paragraph] : []))
              const holder = paragraphs.findIndex((id) =>
                bridge.map.paragraphs[id]?.markers.some((m) => m.owner === 'objects'),
              )
              cells++
              if (holder < 0) return
              withObjects++
              const richCount = visible[block].table?.rows[row]?.[cell.tc]?.richParas?.length ?? 0
              if (richCount !== paragraphs.length) return
              edits.push({
                row,
                tc: cell.tc,
                paras: paragraphs.map((_, i) =>
                  i === holder
                    ? { runs: editRuns(cellRuns(visible[block], row, cell.tc, i), 0, 0, 'X') }
                    : null,
                ),
              })
            }),
          )
          if (!edits.length) continue
          const { bytes } = await editorSave(bridge.docx, (blocks) =>
            blocks.map((b, i) => (i === block ? patchCells(b, edits) : { keep: i })),
          )
          const wb = await writeBack(bridge, bytes)
          const lost = OBJECT_TAGS.filter((t) => count(wb.content, t) !== count(bridge.content, t))
          if (lost.length)
            failures.push(`${name}: editing table cells changed the count of ${lost.join(', ')}`)
          else kept++
        }
      } catch (err) {
        failures.push(`${name}: threw ${(err as Error).stack}`)
      }
    }
    console.log(
      `objects corpus, table cells: cells ${cells}, with objects ${withObjects}, tables edited with every object kept ${kept}, failures ${failures.length}`,
    )
    if (failures.length) console.log(failures.slice(0, 60).join('\n'))
    expect(failures).toEqual([])
  }, 1_200_000)
})
