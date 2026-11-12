import { afterEach, describe, expect, it } from 'vitest'
import { applyTrackedChangesXml, revisionDateMs } from '../src/revision-xml'

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

describe.each(ZONES)('dates that are not an ISO date-time, with the machine in %s', (zone) => {
  /** the changes left after rejecting every insertion recorded before `before` */
  const kept = (dates: string[], before: string) => {
    process.env.TZ = zone
    const xml = hdr(`<w:p>${dates.map((d, i) => ins(i + 1, d, d)).join('')}</w:p>`)
    return texts(applyTrackedChangesXml(xml, 'reject', { before }).xml)
  }

  it('a date with its zone spelled out reads as that instant', () => {
    process.env.TZ = zone
    expect(revisionDateMs('Mon, 01 Jan 2024 10:00:00 GMT')).toBe(Date.UTC(2024, 0, 1, 10))
    expect(kept(['Mon, 01 Jan 2024 10:00:00 GMT'], '2024-01-01T11:00:00Z')).toEqual([])
  })

  it('a date and time with a space between them is UTC, like the T form', () => {
    process.env.TZ = zone
    expect(revisionDateMs('2024-01-01 10:00:00')).toBe(Date.UTC(2024, 0, 1, 10))
    expect(revisionDateMs('2024-01-01 10:00')).toBe(Date.UTC(2024, 0, 1, 10))
  })

  it('a w:date that is no date is not before anything', () => {
    expect(kept(['someday', '2026-01-14T00:00:00Z'], '2026-01-15T00:00:00Z')).toEqual(['someday'])
  })
})

describe('a before that is no date', () => {
  const xml = hdr(`<w:p>${ins(1, '2026-01-14T00:00:00Z', 'kept')}</w:p>`)

  it.each([['someday'], [''], [20260115], [null], [{}]])(
    'refuses %j with its own error, and changes nothing',
    (before) => {
      const run = () =>
        applyTrackedChangesXml(xml, 'reject', { before } as unknown as { before: string })
      expect(run).toThrow(/before/)
      expect(run).not.toThrow(TypeError)
    },
  )
})
