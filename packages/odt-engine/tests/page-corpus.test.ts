/**
 * Local-only run of the page layer over real ODT files (never committed).
 * Skipped unless ODT_CORPUS points at a folder of `.odt` files (one level deep).
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @genoffice/odt-engine
 *
 * For every file: page layouts, master pages and sections convert without
 * throwing and read back as docx sections; an unedited save writes nothing;
 * a margin edit of the final section changes only that run's page layout.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPageExt } from '../src/page'
import { editorSave } from './helpers/bridge'
import { odtToPageBridge, pageWriteBack, sectionsOf } from './helpers/page-bridge'

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

describe.skipIf(!root)('page layer over the corpus', () => {
  it('converts, round-trips unedited and edits one page layout per file', async () => {
    const files = corpusFiles(root as string)
    expect(files.length).toBeGreaterThan(0)
    const totals = {
      files: 0,
      runs: 0,
      sections: 0,
      sharedMasters: 0,
      parts: 0,
      headers: 0,
      headerEdits: 0,
    }
    const failures: string[] = []
    for (const file of files) {
      const name = file.slice((root as string).length + 1)
      try {
        const bridge = await odtToPageBridge(new Uint8Array(readFileSync(file)))
        const ext = readPageExt(bridge.map)
        if (!ext) throw new Error('no page data')
        const { sections, parsed } = await sectionsOf(bridge.docx)
        expect(sections.length, name).toBe(ext.sections.length)
        totals.files++
        totals.runs += ext.runs.filter((r) => !r.hidden).length
        totals.sections += sections.length
        totals.parts += Object.keys(ext.parts).length
        totals.headers += Object.values(parsed.hfParts ?? {}).filter((p) => p.text.trim()).length
        const used = new Map<string, number>()
        for (const r of ext.runs) if (r.master) used.set(r.master, (used.get(r.master) ?? 0) + 1)
        totals.sharedMasters += [...used.values()].filter((n) => n > 1).length

        // unedited
        const same = await pageWriteBack(bridge, bridge.docx)
        if (same.content !== bridge.doc.contentXml || same.styles !== bridge.doc.stylesXml)
          throw new Error('unedited save changed the ODT')

        // a margin edit of the final section
        const last = sections[sections.length - 1]
        const { bytes } = await editorSave(
          bridge.docx,
          (blocks) => blocks.map((_, i) => ({ keep: i })),
          { section: { ...last.settings, marginLeft: last.settings.marginLeft + 567 } },
        )
        const back = await pageWriteBack(bridge, bytes)
        const run = ext.runs[ext.sections[ext.sections.length - 1].run]
        const layout = run.layout ? bridge.doc.styles.pageLayout(run.layout) : undefined
        const master = run.master ? bridge.doc.styles.masterPage(run.master) : undefined
        if (!layout || !master) continue
        const styles = bridge.doc.stylesXml as string
        const shared = (used.get(run.master as string) ?? 0) > 1
        if (!shared && back.content !== bridge.doc.contentXml)
          throw new Error('a margin edit changed content.xml')
        if (!shared) {
          const before = styles.slice(layout.start, layout.end)
          const head = styles.slice(0, layout.start)
          const tail = styles.slice(layout.end)
          if (!back.styles.startsWith(head) || !back.styles.endsWith(tail))
            throw new Error('a margin edit changed more than the page layout')
          const edited = back.styles.slice(head.length, back.styles.length - tail.length)
          if (edited === before || !/fo:margin-left="[^"]*"/.test(edited))
            throw new Error('the margin edit was not written')
        }

        // a header edit of the final section: only its master page changes
        const rId = last.headerRefs.default
        const paras = rId ? parsed.hfParts?.[rId]?.paras : undefined
        if (rId && paras?.length && !shared) {
          const edited = JSON.parse(JSON.stringify(paras.filter((p) => !p.cells))) as typeof paras
          if (edited.length) {
            edited[0].runs.push({ ...(edited[0].runs[0] ?? {}), text: ' edited' })
            const save = await editorSave(
              bridge.docx,
              (blocks) => blocks.map((_, i) => ({ keep: i })),
              { header: { text: '', paras: edited } },
            )
            const out = await pageWriteBack(bridge, save.bytes)
            if (out.content !== bridge.doc.contentXml)
              throw new Error('a header edit changed content.xml')
            // new automatic styles (edited text) may be added; the rest is the master page
            const autos = bridge.doc.styles.containers.styles.automaticStyles
            const at = autos && !autos.selfClosing ? autos.closeStart : master.start
            const middle = styles.slice(at, master.start)
            const rest = out.styles.slice(at)
            const added = rest.indexOf(middle)
            if (
              !out.styles.startsWith(styles.slice(0, at)) ||
              added < 0 ||
              !/^(?:<style:style style:name="[^"]*_io\d+"[\s\S]*?<\/style:style>)*$/.test(
                rest.slice(0, added),
              ) ||
              !out.styles.endsWith(styles.slice(master.end))
            )
              throw new Error('a header edit changed more than its master page')
            if (!out.styles.includes('edited')) throw new Error('the header edit was not written')
            totals.headerEdits++
          }
        }
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`)
      }
    }
    console.log(`page corpus: ${JSON.stringify(totals)}`)
    expect(failures).toEqual([])
  }, 600_000)
})
