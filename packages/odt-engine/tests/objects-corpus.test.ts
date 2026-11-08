/**
 * Local-only run of the objects layer over real ODT files (never committed).
 * Skipped unless ODT_CORPUS points at a folder of `.odt` files (one level deep).
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @genoffice/odt-engine
 *
 * For every file: conversion with text + objects must not throw; every
 * picture, placeholder, note and comment reaches the bridge docx; paragraphs
 * holding objects read back with their recorded text; an unedited save writes
 * nothing and changes no package entry; editing every paragraph that holds an
 * object keeps every object; editing a note's text rewrites only its
 * paragraph. Counts per kind are printed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type OdtNode,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
  buildBridgeDocx,
  openOdt,
  scanOdtBody,
  walkNodes,
} from '../src/core'
import type { ObjectsExt } from '../src/objects'
import {
  convertOdtStyles,
  editedParagraphFromBlock,
  paragraphToOdf,
  paragraphToOoxml,
} from '../src/text'
import { editOnly, editorSave, odtToBridge, replaceText } from './helpers/bridge'
import { objectsRegistry, visibleBlocks, writeBackObjects } from './helpers/objects-fixtures'

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
        const bridge = await odtToBridge(bytes, objectsRegistry())
        const ext = (bridge.map.ext.objects ?? {
          placeholders: [],
          pictures: [],
          notes: [],
          comments: [],
        }) as unknown as ObjectsExt
        const fixture = {
          bridge,
          ext,
          built: {
            bytes,
            entries: [],
            contentXml: bridge.doc.contentXml,
            stylesXml: bridge.doc.stylesXml ?? '',
            metaXml: bridge.doc.metaXml ?? '',
            manifestXml: bridge.doc.pkg.text('META-INF/manifest.xml') ?? '',
          },
        }
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
        const wb0 = await writeBackObjects(fixture, same.bytes)
        if (
          wb0.content !== bridge.doc.contentXml ||
          wb0.changes.add.length ||
          wb0.changes.remove.length ||
          wb0.manifest !== fixture.built.manifestXml
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
          const wb = await writeBackObjects(fixture, changed)
          const lost = OBJECT_TAGS.filter(
            (t) => count(wb.content, t) !== count(bridge.doc.contentXml, t),
          )
          if (lost.length) failures.push(`${name}: editing changed the count of ${lost.join(', ')}`)
          else if (wb.changes.add.length || wb.changes.remove.length)
            failures.push(`${name}: editing text changed package entries`)
          else if (scanOdtBody(wb.content).warnings.length !== bridge.doc.body.warnings.length)
            failures.push(`${name}: editing produced malformed XML`)
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
          const wb = await writeBackObjects(fixture, changed)
          const host = bridge.map.paragraphs[note.paragraph]
          const original = bridge.doc.contentXml
          let stripped = wb.content
          for (const x of wb.rctx.newAutomaticStyles('content.xml'))
            stripped = stripped.replace(x, '')
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

  it('converts the objects of every paragraph anywhere (table cells included) and writes them back', async () => {
    const files = corpusFiles(root as string)
    const failures: string[] = []
    let paragraphs = 0
    let withObjects = 0
    let identical = 0
    const kinds: Record<string, number> = {}
    const containsTable = (n: OdtNode) => {
      let found = false
      walkNodes(n.children, (c) => {
        if (c.kind === 'table') found = true
        return !found
      })
      return found
    }
    for (const file of files) {
      const name = file.split(/[\\/]/).pop()
      try {
        const doc = await openOdt(new Uint8Array(readFileSync(file)))
        const ctx = new OdfToOoxmlContext(doc, objectsRegistry())
        convertOdtStyles(ctx)
        const holder = ctx.addBlock(doc.body.blocks[0], null, 'test')
        walkNodes(doc.body.blocks, (n) => {
          // objects the editor cannot change keep their inner paragraphs
          if (n.kind === 'note' || n.kind === 'annotation' || n.kind === 'shape') return false
          if (n.kind === 'text-box' && !containsTable(n)) return false
          if (n.kind === 'index') return false
          if (n.kind !== 'paragraph' && n.kind !== 'heading') return
          const { xml, paragraph } = paragraphToOoxml(ctx, n, { part: 'content.xml' })
          ctx.addElement(holder.id, xml, 'paragraph', paragraph.id)
        })
        const ext = ctx.map.ext.objects as unknown as ObjectsExt | undefined
        const tally = (k: string, n: number) => (kinds[k] = (kinds[k] ?? 0) + n)
        tally('picture', ext?.pictures.length ?? 0)
        for (const p of ext?.placeholders ?? []) tally(p.kind, 1)
        for (const n of ext?.notes ?? []) tally(n.kind, 1)
        tally('comment', ext?.comments.length ?? 0)
        const docx = await buildBridgeDocx(ctx)
        const { parsed } = await visibleBlocks(docx)
        const map = JSON.parse(JSON.stringify(ctx.map)) as typeof ctx.map
        const rctx = new OoxmlToOdfContext(doc, map, parsed, ctx.registry)
        const byIndex = new Map(parsed.blocks.map((b) => [b.docxIndex, b]))
        for (const e of map.elements) {
          if (e.paragraph === null) continue
          const record = map.paragraphs[e.paragraph]
          paragraphs++
          if (!record.markers.some((m) => m.owner === 'objects')) continue
          withObjects++
          const block = byIndex.get(e.id)
          if (!block || (block.type !== 'paragraph' && block.type !== 'listItem')) continue
          const text = (block.runs ?? []).map((r) => r.text).join('')
          if (text !== record.text) {
            failures.push(
              `${name} p${record.id}: read back ${JSON.stringify(text)} vs ${JSON.stringify(record.text)}`,
            )
            continue
          }
          const source = doc.contentXml.slice(record.start, record.end)
          const odf = paragraphToOdf(rctx, editedParagraphFromBlock(block), record, {
            part: record.part,
          })
          const lost = OBJECT_TAGS.filter((t) => count(odf, t) !== count(source, t))
          if (lost.length) failures.push(`${name} p${record.id}: rewriting lost ${lost.join(', ')}`)
          else if (odf === source) identical++
        }
      } catch (err) {
        failures.push(`${name}: threw ${(err as Error).stack}`)
      }
    }
    console.log(
      `objects corpus, all paragraphs: paragraphs ${paragraphs}, with objects ${withObjects}, ` +
        `objects ${JSON.stringify(kinds)}, ` +
        `rewritten byte-identical ${identical}, failures ${failures.length}`,
    )
    if (failures.length) console.log(failures.slice(0, 60).join('\n'))
    expect(failures).toEqual([])
  }, 1_200_000)
})
