/**
 * Local-only sanity run over real ODT files. Skipped unless ODT_CORPUS points at
 * a folder of `.odt` files (searched one level deep). Real files never enter
 * the repository; they may contain personal data.
 *
 *   ODT_CORPUS=E:/github/odt-corpus npm run test -w @genoffice/odt-engine
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type OdtNode, openOdt, pairBookmarks, walkNodes } from '../src/core'

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

/** Elements whose every occurrence inside office:text must become a node. */
const COUNTED = [
  'text:p',
  'text:h',
  'text:list',
  'table:table',
  'table:table-row',
  'table:table-cell',
  'table:covered-table-cell',
  'draw:frame',
  'draw:text-box',
  'draw:image',
  'text:bookmark-start',
  'text:bookmark-end',
  'text:bookmark',
  'office:annotation',
  'text:note',
  'office:annotation-end',
  'text:list-item',
  'text:section',
  'draw:object',
  'draw:custom-shape',
  'draw:rect',
  'draw:g',
]

describe.skipIf(!root)('real ODT corpus (ODT_CORPUS)', () => {
  it('opens every file and every recorded range slices to its element', async () => {
    const files = corpusFiles(root as string)
    expect(files.length).toBeGreaterThan(0)
    const failures: string[] = []
    let opened = 0
    let nodes = 0
    let styles = 0
    for (const file of files) {
      try {
        const doc = await openOdt(new Uint8Array(readFileSync(file)))
        const xml = doc.contentXml
        const counts = new Map<string, number>()
        let previousEnd = doc.body.text.openEnd
        for (const block of doc.body.blocks) {
          const gap = xml.slice(previousEnd, block.start)
          if (gap.trim() !== '')
            failures.push(`${file}: non-blank gap before block at ${block.start}`)
          previousEnd = block.end
        }
        walkNodes(doc.body.blocks, (node: OdtNode) => {
          nodes++
          counts.set(node.name, (counts.get(node.name) ?? 0) + 1)
          const text = xml.slice(node.start, node.end)
          if (node.kind === 'opaque') return
          const ok =
            text.startsWith(`<${node.tag}`) &&
            /[\s/>]/.test(text.charAt(node.tag.length + 1)) &&
            text.endsWith(node.selfClosing ? '/>' : `</${node.tag}>`) &&
            (!node.parent ||
              (node.start >= node.parent.openEnd && node.end <= node.parent.closeStart))
          if (!ok && failures.length < 50)
            failures.push(`${file}: bad range for ${node.name}@${node.start}`)
        })
        // no element is missed: count raw occurrences inside office:text
        const inner = xml.slice(doc.body.text.openEnd, doc.body.text.closeStart)
        for (const name of COUNTED) {
          const raw = inner.match(new RegExp(`<${name}[\\s/>]`, 'g'))?.length ?? 0
          if (raw !== (counts.get(name) ?? 0)) {
            failures.push(`${file}: ${name} raw ${raw} vs nodes ${counts.get(name) ?? 0}`)
          }
        }
        for (const pair of pairBookmarks(doc.body)) {
          const node = (pair.start ?? pair.point ?? pair.end) as OdtNode
          const raw = node.attrRaw('text:name')
          if (raw === undefined || !xml.slice(node.start, node.end).includes(raw)) {
            failures.push(`${file}: bookmark name not verbatim`)
          }
        }
        for (const style of doc.styles.all) {
          styles++
          const src = style.part === 'content.xml' ? xml : (doc.stylesXml as string)
          const text = src.slice(style.start, style.end)
          if (
            !text.startsWith(`<${style.tag}`) ||
            !text.endsWith(style.selfClosing ? '/>' : `</${style.tag}>`)
          ) {
            failures.push(`${file}: bad style range ${style.name}`)
          }
        }
        // no style is missed: count raw style:style elements outside the body
        const rawStyles =
          (xml.slice(0, doc.body.text.start).match(/<style:style[\s/>]/g)?.length ?? 0) +
          ((doc.stylesXml ?? '').match(/<style:style[\s/>]/g)?.length ?? 0)
        const recorded = doc.styles.all.filter((s) => s.kind === 'style').length
        if (rawStyles !== recorded)
          failures.push(`${file}: style:style raw ${rawStyles} vs ${recorded}`)
        if (doc.generator.name === null) failures.push(`${file}: no generator`)
        opened++
      } catch (err) {
        failures.push(`${file}: threw ${(err as Error).message}`)
      }
    }
    console.log(
      `corpus: opened ${opened}/${files.length}, nodes ${nodes}, styles ${styles}, failures ${failures.length}`,
    )
    expect(failures).toEqual([])
  }, 600_000)
})
