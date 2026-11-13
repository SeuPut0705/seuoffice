import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { canonicalXmlSpelling } from '../src/gateway/xlsx-xml-scan'
import { TAG_MUTATION_NAMES, hiddenBook, mutatePackage, padSheet } from './helpers/hidden-book'
import { parseXml } from './helpers/xml-oracle'

/**
 * The patterns that move cells with a mark read one spelling of a tag. A part
 * past 2 MiB is rewritten only when a cheap test finds a spelling they cannot
 * read: whatever that test lets through must already be that spelling, for
 * every way the tags can be written.
 */
const LARGE = 2 * 1024 * 1024 + 1

describe.each(TAG_MUTATION_NAMES)('a worksheet past 2 MiB, tags rewritten: %s', (mutation) => {
  it('comes out in the one spelling the patterns read, and means what it meant', async () => {
    const zip = await JSZip.loadAsync(
      await mutatePackage(
        await padSheet(await hiddenBook({ record: 'part', pivotOver: 'Report' }), LARGE),
        mutation,
      ),
    )
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet.length).toBeGreaterThan(LARGE)

    const out = canonicalXmlSpelling(sheet)

    expect(out).not.toMatch(/<!--|<!\[CDATA\[/)
    expect(out).not.toMatch(/<\/[^>\s]+\s+>/)
    expect(out).not.toMatch(/<[^<>]*(?:='|\s=|=\s)/)
    // no `>` left inside a quoted value
    expect(out).not.toMatch(/="[^"<]*>/)
    const root = parseXml(out)
    const before = parseXml(sheet)
    expect(root.name).toBe(before.name)
    expect(root.children.map((child) => child.name)).toEqual(
      before.children.map((child) => child.name),
    )
  })
})
