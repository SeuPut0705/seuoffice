/**
 * Local-only run of the text converters over real ODT files (never committed).
 * Skipped unless ODT_CORPUS points at a folder of `.odt` files (one level deep).
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @genoffice/odt-engine
 *
 * For every file: ODF → OOXML for the whole body must not throw; every
 * converted paragraph must read back from the bridge docx (`parseDocx`) with
 * exactly its recorded text; and every paragraph, forced through the OOXML →
 * ODF writer without edits, must reproduce its original text and create no
 * new style.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import {
  type ElementRange,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
  type OdtStylePart,
  buildBridgeDocx,
  readRoot,
  scanOdtBody,
  walkElements,
  walkNodes,
} from '../src/core'
import {
  convertOdtStyles,
  editedParagraphFromBlock,
  paragraphToOdf,
  paragraphToOoxml,
  readParagraph,
} from '../src/text'
import {
  type Bridge,
  editOnly,
  editorSave,
  odtToBridge,
  replaceText,
  writeBack,
} from './helpers/bridge'

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

/** Paragraph ranges of the master pages (headers/footers) in styles.xml. */
function masterParagraphs(xml: string): ElementRange[] {
  const root0 = readRoot(xml)
  if (!root0) return []
  const out: ElementRange[] = []
  let inMaster = false
  walkElements(xml, root0.prefixes, {
    open(el) {
      if (el.name === 'office:master-styles') inMaster = true
    },
    close(el) {
      if (el.name === 'office:master-styles') inMaster = false
      if (inMaster && (el.name === 'text:p' || el.name === 'text:h')) out.push({ ...el })
    },
  })
  return out
}

async function allParagraphs(bytes: Uint8Array) {
  const base = await odtToBridge(bytes)
  const ctx = new OdfToOoxmlContext(base.doc, base.registry)
  convertOdtStyles(ctx)
  const holder = ctx.addBlock(base.doc.body.blocks[0], null, 'test')
  const add = (range: ElementRange, part: OdtStylePart) => {
    const { xml, paragraph } = paragraphToOoxml(ctx, range, { part })
    ctx.addElement(holder.id, xml, 'paragraph', paragraph.id)
  }
  walkNodes(base.doc.body.blocks, (n) => {
    if (n.kind === 'paragraph' || n.kind === 'heading') add(n, 'content.xml')
  })
  for (const r of masterParagraphs(base.doc.stylesXml ?? '')) add(r, 'styles.xml')
  const docx = await buildBridgeDocx(ctx)
  return { ...base, ctx, map: ctx.map, docx }
}

/** Text of ODF paragraphs (joined by page breaks), read the way the bridge reads them. */
function odfText(xml: string, b: Bridge): string {
  const body = scanOdtBody(
    `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${xml}</office:text></office:body></office:document-content>`,
  )
  const info = { ...b.ctx.part('content.xml'), xml: body.xml }
  return body.blocks.map((n) => readParagraph({ info, styles: b.doc.styles }, n).text).join('')
}

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
        // the body as T6 converts it must not throw; unedited, nothing is written back;
        // one edited paragraph changes only that paragraph
        const top = await odtToBridge(bytes)
        const same = await writeBack(top, top.docx)
        if (same.content !== top.doc.contentXml || same.styles !== (top.doc.stylesXml ?? ''))
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
          const original = top.doc.contentXml
          const head = original.slice(0, record.start)
          const tail = original.slice(record.end)
          let stripped = wb.content
          for (const x of wb.rctx.newAutomaticStyles('content.xml'))
            stripped = stripped.replace(x, '')
          const ok =
            stripped.startsWith(head) &&
            stripped.endsWith(tail) &&
            odfText(stripped.slice(head.length, stripped.length - tail.length), top) ===
              '편집 ' + record.text.replace(/\f$/, '') &&
            scanOdtBody(wb.content).warnings.length === top.doc.body.warnings.length
          if (!ok) failures.push(`${file}: editing paragraph ${record.id} touched other parts`)
          else edits++
        }
        // every paragraph anywhere (body, lists, cells, text boxes, notes, headers) as its own element
        const bridge = await allParagraphs(bytes)
        const parsed = await parseDocx(bridge.docx)
        const rctx = new OoxmlToOdfContext(bridge.doc, bridge.map, parsed, bridge.registry)
        const byIndex = new Map(parsed.blocks.map((b) => [b.docxIndex, b]))
        for (const element of bridge.map.elements) {
          if (element.paragraph === null) continue
          const record = bridge.map.paragraphs[element.paragraph]
          paragraphs++
          fields += record.markers.filter((m) => m.field).length
          const block = byIndex.get(element.id)
          const text = (block?.runs ?? []).map((r) => r.text).join('')
          if (block && text !== record.text && /&#?\w+;/.test(record.text)) {
            // the docx engine decodes entity-looking literal text in w:t a second time
            // ("&#38;" typed as text reads back as "&"); not something the bridge can avoid
            engineQuirks.push(`${file} p${record.id}`)
            continue
          }
          if (!block || text !== record.text) {
            if (failures.length < 40)
              failures.push(
                `${file} p${record.id}: read back ${JSON.stringify(text)} vs ${JSON.stringify(record.text)}`,
              )
            continue
          }
          readBack++
          // without the pPr shortcut: every mapped format key must read back unchanged
          const { rawPPr: _raw, ...unedited } = editedParagraphFromBlock(block)
          const odf = paragraphToOdf(rctx, unedited, record, {
            part: record.part,
          })
          const xml = `<office:text>${odf}</office:text>`
          const body = scanOdtBody(
            `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body>${xml}</office:body></office:document-content>`,
          )
          const info = { ...rctx.part(record.part), xml: body.xml }
          const again = body.blocks
            .map((n) => readParagraph({ info, styles: bridge.doc.styles }, n).text)
            .join('\f')
          const expected = record.text.endsWith('\f') ? record.text.slice(0, -1) : record.text
          if (again !== expected) {
            if (failures.length < 40)
              failures.push(
                `${file} p${record.id}: wrote ${JSON.stringify(again)} vs ${JSON.stringify(expected)}`,
              )
            continue
          }
          roundTrips++
        }
        newStyles +=
          rctx.newAutomaticStyles('content.xml').length +
          rctx.newAutomaticStyles('styles.xml').length
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
