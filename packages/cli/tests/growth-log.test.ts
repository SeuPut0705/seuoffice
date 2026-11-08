import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  buildSummary,
  mergeSnapshot,
  renderReport,
} from '../../../tools/growth-log.mjs'

const RELEASES = [
  {
    tag_name: 'v0.12.1',
    published_at: '2026-10-16T01:12:50Z',
    assets: [
      { name: 'IeumOffice-Setup-0.12.1.exe', download_count: 61 },
      { name: 'IeumOffice-0.12.1-arm64.dmg', download_count: 7 },
      { name: 'IeumOffice-0.12.1-arm64-mac.zip', download_count: 1 },
      { name: 'IeumOffice-0.12.1.AppImage', download_count: 3 },
      { name: 'ieumoffice_0.12.1_amd64.deb', download_count: 2 },
      { name: 'ieumoffice-0.12.1.x86_64.rpm', download_count: 1 },
      { name: 'latest.yml', download_count: 112 },
      { name: 'latest-mac.yml', download_count: 26 },
      { name: 'latest-linux.yml', download_count: 5 },
      { name: 'IeumOffice-0.12.1.exe.blockmap', download_count: 5 },
    ],
  },
  {
    tag_name: 'v0.12.0',
    published_at: '2026-10-14T22:49:05Z',
    assets: [
      { name: 'IeumOffice-Setup-0.12.0.exe', download_count: 112 },
      { name: 'IeumOffice-0.12.0-arm64.dmg', download_count: 10 },
      { name: 'latest.yml', download_count: 128 },
    ],
  },
]

const snapshot = buildSnapshot({
  releases: RELEASES,
  stars: 4,
  forks: 3,
  date: '2026-10-17',
})

describe('buildSnapshot', () => {
  it('counts installers as downloads and keeps update manifests separate', () => {
    expect(snapshot.totalDownloads).toBe(197)
    expect(snapshot.installs.windows).toBe(173)
    expect(snapshot.installs.macos).toBe(18)
    expect(snapshot.installs.linux).toBe(6)
    expect(snapshot.updateChecks).toBe(271)
  })

  it('ignores support files such as .blockmap', () => {
    expect(snapshot.perAsset.map((a) => a.asset)).not.toContain('IeumOffice-0.12.1.exe.blockmap')
  })

  it('sums installer downloads per release', () => {
    expect(snapshot.releases).toEqual([
      { tag: 'v0.12.1', publishedAt: '2026-10-16T01:12:50Z', downloads: 75 },
      { tag: 'v0.12.0', publishedAt: '2026-10-14T22:49:05Z', downloads: 122 },
    ])
  })

  it('rejects a non-array payload', () => {
    expect(() =>
      buildSnapshot({ releases: { message: 'API rate limit' }, stars: 0, forks: 0, date: 'x' }),
    ).toThrow(/non-array/)
  })
})

describe('mergeSnapshot', () => {
  it('appends a new day', () => {
    const merged = mergeSnapshot([snapshot], { ...snapshot, date: '2026-10-18' })
    expect(merged.map((s) => s.date)).toEqual(['2026-10-17', '2026-10-18'])
  })

  it('replaces the same day and keeps other days verbatim', () => {
    const otherDay = { ...snapshot, date: '2026-10-16', stars: 9 }
    const merged = mergeSnapshot([otherDay, snapshot], { ...snapshot, stars: 5 })
    expect(merged).toHaveLength(2)
    expect(merged.find((s) => s.date === '2026-10-17')?.stars).toBe(5)
    expect(merged.find((s) => s.date === '2026-10-16')?.stars).toBe(9)
  })
})

describe('buildSummary', () => {
  it('flattens the snapshot for the badge file', () => {
    expect(buildSummary(snapshot)).toEqual({
      date: '2026-10-17',
      totalDownloads: 197,
      windowsInstalls: 173,
      macosInstalls: 18,
      linuxInstalls: 6,
      updateChecks: 271,
      stars: 4,
      forks: 3,
    })
  })
})

describe('renderReport', () => {
  it('says there is nothing to report on an empty history', () => {
    expect(renderReport([])).toMatch(/No growth snapshots/)
  })

  it('reports the first day without a comparison', () => {
    const report = renderReport([snapshot])
    expect(report).toMatch(/First recorded day/)
    expect(report).toMatch(/v0\.12\.1.*75/)
  })

  it('reports day-over-day deltas and a 7-day trend', () => {
    const week = Array.from({ length: 7 }, (_, i) => ({
      ...snapshot,
      date: `2026-10-${10 + i}`,
      installs: { windows: 100 + i * 10, macos: 10, linux: 2 },
    }))
    const report = renderReport([...week, snapshot])
    expect(report).toMatch(/total downloads: 197/)
    expect(report).toMatch(/windows installs: 173 \(\+13/)
    expect(report).toMatch(/linux installs: 6 \(\+4/)
    expect(report).toMatch(/Windows installs over the last 7 days: \+73/)
  })
})
