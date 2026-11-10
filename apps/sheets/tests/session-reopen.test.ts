import { describe, expect, it } from 'vitest'

import { continuedOpenOptions, sessionToContinue } from '../src/main/session-reopen'

const plain = { path: '/docs/report.xlsx', snapshotPath: '/tmp/snap-1', sha256: 'a' }
const converted = {
  path: '/tmp/genoffice-imports/abc/book.xlsx',
  snapshotPath: '/tmp/snap-2',
  sha256: 'b',
  suggestSaveAs: '/docs/book.xlsx',
  importTempDir: '/tmp/genoffice-imports/abc',
  odsConverted: true,
  formulasDropped: 3,
  odsSourcePath: '/docs/book.ods',
}

describe('sessionToContinue', () => {
  it('leaves a plain workbook to the ordinary open', () => {
    expect(sessionToContinue([plain], '/docs/report.xlsx')).toBeNull()
  })

  it('finds the converted session behind the temp copy the renderer names', () => {
    expect(sessionToContinue([plain, converted], converted.path)).toBe(converted)
    expect(sessionToContinue([plain, converted], '/docs/book.ods')).toBeNull()
  })

  it('finds a restored copy by the original path the renderer was given', () => {
    const restored = {
      path: '/userdata/recovery/copy.xlsx',
      snapshotPath: '/tmp/snap-3',
      sha256: 'c',
      restoreTarget: '/docs/plan.xlsx',
    }
    expect(sessionToContinue([restored], '/docs/plan.xlsx')).toBe(restored)
    expect(sessionToContinue([restored], restored.path)).toBeNull()
  })

  it('continues the session opened last', () => {
    const later = { ...converted, snapshotPath: '/tmp/snap-4' }
    expect(sessionToContinue([converted, later], converted.path)).toBe(later)
  })

  it('counts a csv, a new workbook and a decrypted one as more than a path', () => {
    const csv = { ...plain, path: '/tmp/i/data.xlsx', csvSourcePath: '/docs/data.csv' }
    const fresh = { ...plain, path: '/tmp/new/untitled.xlsx', unsavedNew: true }
    const locked = { ...plain, path: '/tmp/d/locked.xlsx', password: 'pw' }
    expect(sessionToContinue([csv], csv.path)).toBe(csv)
    expect(sessionToContinue([fresh], fresh.path)).toBe(fresh)
    expect(sessionToContinue([locked], locked.path)).toBe(locked)
  })
})

describe('continuedOpenOptions', () => {
  it('carries what the session remembers and not the directory it owns', () => {
    expect(continuedOpenOptions(converted)).toEqual({
      suggestSaveAs: '/docs/book.xlsx',
      odsConverted: true,
      formulasDropped: 3,
      odsSourcePath: '/docs/book.ods',
    })
  })

  it('carries a csv source, a restore target and a recovery identity', () => {
    const identity = { kind: 'untitled', id: 'x' }
    expect(
      continuedOpenOptions({
        path: '/tmp/i/data.xlsx',
        csvImport: true,
        csvSourcePath: '/docs/data.csv',
        restoreTarget: '/docs/plan.xlsx',
        recoveryIdentity: identity,
        recoveryOriginalPath: '/docs/data.csv',
        unsavedRestore: true,
      }),
    ).toEqual({
      csvImport: true,
      csvSourcePath: '/docs/data.csv',
      restoreTarget: '/docs/plan.xlsx',
      recoveryIdentity: identity,
      recoveryOriginalPath: '/docs/data.csv',
      unsavedRestore: true,
    })
  })
})
