import { afterEach, describe, expect, it } from 'vitest'
import { applyTrackedChangesXml } from '../src/revision-xml'

/**
 * `before` picks the changes recorded before an instant. A date written
 * without a zone designator is UTC, so the same file gives the same answer on
 * every machine. Each case runs under a zone east and a zone west of UTC.
 */

const r = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`
const hdr = (body: string) => `<w:hdr xmlns:w="w">${body}</w:hdr>`
const ins = (id: number, date: string, text: string) =>
  `<w:ins w:id="${id}" w:author="A" w:date="${date}">${r(text)}</w:ins>`
const texts = (xml: string) => [...xml.matchAll(/<w:t>([^<]*)<\/w:t>/g)].map((m) => m[1])

const ZONES = ['Asia/Seoul', 'America/Los_Angeles']
const hostZone = process.env.TZ

afterEach(() => {
  if (hostZone === undefined) delete process.env.TZ
  else process.env.TZ = hostZone
})

describe.each(ZONES)('the before filter with the machine in %s', (zone) => {
  /** the changes left after rejecting every insertion recorded before `before` */
  const kept = (dates: string[], before: string) => {
    process.env.TZ = zone
    const xml = hdr(`<w:p>${dates.map((d, i) => ins(i + 1, d, d)).join('')}</w:p>`)
    return texts(applyTrackedChangesXml(xml, 'reject', { before }).xml)
  }

  it('a w:date without a zone is UTC', () => {
    expect(kept(['2026-01-14T23:30:00', '2026-01-15T00:30:00'], '2026-01-15T00:00:00Z')).toEqual([
      '2026-01-15T00:30:00',
    ])
  })

  it('a before without a zone is UTC', () => {
    expect(kept(['2026-01-14T23:30:00Z', '2026-01-15T00:30:00Z'], '2026-01-15T00:00:00')).toEqual([
      '2026-01-15T00:30:00Z',
    ])
    expect(kept(['2026-01-14T23:30:00Z', '2026-01-15T00:30:00Z'], '2026-01-15')).toEqual([
      '2026-01-15T00:30:00Z',
    ])
  })

  it('a zone designator keeps its meaning', () => {
    expect(
      kept(
        ['2026-01-15T08:30:00+09:00', '2026-01-14T16:30:00-08:00', '2026-01-14T23:59:59.5Z'],
        '2026-01-15T00:00:00Z',
      ),
    ).toEqual(['2026-01-14T16:30:00-08:00'])
  })

  it('the instant itself is not before', () => {
    expect(kept(['2026-01-15T00:00:00'], '2026-01-15T00:00:00Z')).toEqual(['2026-01-15T00:00:00'])
  })
})
