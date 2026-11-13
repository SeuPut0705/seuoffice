import { describe, expect, it } from 'vitest'
import { applyRevisionResolutions, applyTrackedChangesXml } from '../src'
import { OWN_REDACT_NS, SECRET, TAG_MUTATIONS, type MarkSpelling } from './helpers/hidden-stories'

/**
 * Rejecting a formatting change puts the run's old properties back. The mark
 * that hides a run from AI is not formatting: it was never in the old
 * properties, so it stays, whatever the run looked like before.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const REV = ' w:id="7" w:author="Ann" w:date="2026-09-29T12:23:00Z"'
const BDR = '<w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/>'

const MARKS: Record<MarkSpelling, string> = {
  go: `<go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/>`,
  'other prefix': `<gx:redact xmlns:gx="${OWN_REDACT_NS}" w:label="client phone"/>`,
  unprefixed: `<redact xmlns="${OWN_REDACT_NS}" w:label="client phone"/>`,
  'unprefixed, inherited': '<redact w:label="client phone"/>',
  spaced: `<go:redact xmlns:go="${OWN_REDACT_NS}" w:label="client phone"/>`,
}

/** a part with one run whose formatting change is pending and which carries the mark */
function part(spelling: MarkSpelling, oldRPr: string, { border = true } = {}): string {
  const rPrOpen =
    spelling === 'unprefixed, inherited' ? `<w:rPr xmlns="${OWN_REDACT_NS}">` : '<w:rPr>'
  return (
    `<w:hdr ${W}><w:p><w:r>${rPrOpen}<w:b/>${border ? BDR : ''}${MARKS[spelling]}` +
    `<w:rPrChange${REV}>${oldRPr}</w:rPrChange></w:rPr><w:t>${SECRET}</w:t></w:r></w:p></w:hdr>`
  )
}

const marked = (xml: string) => /<(?:[\w.-]+:)?redact[\s/>]/.test(xml)

describe.each(Object.keys(MARKS) as MarkSpelling[])(
  'rejecting a formatting change, mark spelled %s',
  (spelling) => {
    it('keeps the mark when the old properties were empty', () => {
      const out = applyTrackedChangesXml(part(spelling, '<w:rPr/>'), 'reject')
      expect(out.applied).toBe(1)
      expect(out.xml).not.toContain('rPrChange')
      expect(marked(out.xml)).toBe(true)
      expect(out.xml).not.toContain('<w:b/>')
      expect(out.xml).toContain(SECRET)
    })

    it('keeps the mark and puts the old properties back', () => {
      const out = applyTrackedChangesXml(part(spelling, '<w:rPr><w:i/></w:rPr>'), 'reject')
      expect(out.xml).not.toContain('rPrChange')
      expect(marked(out.xml)).toBe(true)
      expect(out.xml).toContain('<w:i/>')
      expect(out.xml).not.toContain('<w:b/>')
    })

    it('keeps the mark when the change is accepted', () => {
      const out = applyTrackedChangesXml(part(spelling, '<w:rPr/>'), 'accept')
      expect(marked(out.xml)).toBe(true)
      expect(out.xml).toContain('<w:b/>')
    })
  },
)

describe('rejecting a formatting change', () => {
  it('keeps the label, once', () => {
    const out = applyTrackedChangesXml(part('go', '<w:rPr/>'), 'reject').xml
    expect(out.match(/w:label="client phone"/g)).toHaveLength(1)
  })

  it('keeps a mark whose border the old properties had too, without doubling the border', () => {
    const out = applyTrackedChangesXml(part('go', `<w:rPr>${BDR}</w:rPr>`), 'reject').xml
    expect(marked(out)).toBe(true)
    expect(out.match(/<w:bdr /g)).toHaveLength(1)
  })

  it('replays as the editor records it, by filter', () => {
    const out = applyRevisionResolutions(part('go', '<w:rPr/>'), [
      { mode: 'reject', filter: { type: 'formatting' } },
    ])
    expect(marked(out)).toBe(true)
    expect(out).not.toContain('rPrChange')
  })

  it('leaves a run with no mark exactly as before: the old properties back, an empty holder gone', () => {
    const plain = `<w:hdr ${W}><w:p><w:r><w:rPr><w:b/><w:rPrChange${REV}><w:rPr/></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p></w:hdr>`
    expect(applyTrackedChangesXml(plain, 'reject').xml).toBe(
      `<w:hdr ${W}><w:p><w:r><w:t>x</w:t></w:r></w:p></w:hdr>`,
    )
  })

  it.each(Object.keys(TAG_MUTATIONS) as Array<keyof typeof TAG_MUTATIONS>)(
    'keeps the mark with the tags rewritten: %s',
    (mutation) => {
      const xml = TAG_MUTATIONS[mutation](part('go', '<w:rPr><w:i/></w:rPr>'))
      const out = applyTrackedChangesXml(xml, 'reject').xml
      expect(marked(out)).toBe(true)
      expect(out).toContain(SECRET)
    },
  )
})

describe('a caller acting for a model leaves pending what would remove hidden words', () => {
  const REVS = (words: string) =>
    `<w:hdr ${W}>` +
    `<w:p><w:ins${REV}><w:r><w:rPr>${MARKS.go}</w:rPr><w:t>${words}</w:t></w:r></w:ins></w:p>` +
    `<w:p><w:del w:id="8" w:author="Ann" w:date="2026-09-29T12:23:00Z"><w:r><w:rPr>${MARKS.go}</w:rPr><w:delText>${words}</w:delText></w:r></w:del></w:p>` +
    `<w:p><w:ins w:id="9" w:author="Ann" w:date="2026-09-29T12:23:00Z"><w:r><w:t>plain</w:t></w:r></w:ins></w:p>` +
    '</w:hdr>'

  it('rejecting: the hidden insertion stays, the plain one goes, the hidden deletion comes back', () => {
    const out = applyTrackedChangesXml(REVS(SECRET), 'reject', { keepHidden: true })
    expect(out.applied).toBe(2)
    expect(out.remaining).toBe(1)
    expect(out.xml).toContain(`<w:ins${REV}>`)
    expect(out.xml).not.toContain('plain')
    expect(out.xml).toContain(`<w:t>${SECRET}</w:t>`)
  })

  it('accepting: the hidden deletion stays, the plain insertion is kept, the hidden insertion is kept', () => {
    const out = applyTrackedChangesXml(REVS(SECRET), 'accept', { keepHidden: true })
    expect(out.applied).toBe(2)
    expect(out.remaining).toBe(1)
    expect(out.xml).toContain('<w:del ')
    expect(out.xml).toContain('plain')
  })

  it('a row that holds hidden words is not removed', () => {
    const row = (kind: 'ins' | 'del') =>
      `<w:tbl><w:tr><w:trPr><w:${kind}${REV}/></w:trPr><w:tc><w:p><w:r><w:rPr>${MARKS.go}</w:rPr><w:t>${SECRET}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
    const wrap = (inner: string) => `<w:hdr ${W}>${inner}</w:hdr>`
    expect(applyTrackedChangesXml(wrap(row('ins')), 'reject', { keepHidden: true }).applied).toBe(0)
    expect(applyTrackedChangesXml(wrap(row('del')), 'accept', { keepHidden: true }).applied).toBe(0)
    // the person's own reject is not held back
    expect(applyTrackedChangesXml(wrap(row('ins')), 'reject').applied).toBe(1)
  })

  it('formatting changes are never held back', () => {
    const out = applyTrackedChangesXml(part('go', '<w:rPr/>'), 'reject', { keepHidden: true })
    expect(out.applied).toBe(1)
    expect(marked(out.xml)).toBe(true)
  })

  it.each(Object.keys(TAG_MUTATIONS) as Array<keyof typeof TAG_MUTATIONS>)(
    'holds back the hidden insertion with the tags rewritten: %s',
    (mutation) => {
      const out = applyTrackedChangesXml(TAG_MUTATIONS[mutation](REVS(SECRET)), 'reject', {
        keepHidden: true,
      })
      expect(out.xml).toContain(SECRET)
    },
  )
})
