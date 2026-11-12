import { describe, expect, it, vi } from 'vitest'
import { runGuardedCandidate, runGuardedDocumentAction } from '../src/renderer/doc-dirty'
import { findDocxPath, isWord97Path } from '../src/shared/open-file'

describe('findDocxPath', () => {
  it('finds Finder and Explorer document arguments case-insensitively', () => {
    expect(findDocxPath(['/Applications/SeuOffice Docs.app', '/tmp/Quarterly Plan.docx'])).toBe(
      '/tmp/Quarterly Plan.docx',
    )
    expect(findDocxPath(['SeuOffice Docs.exe', 'C:\\Users\\Me\\REPORT.DOCX'])).toBe(
      'C:\\Users\\Me\\REPORT.DOCX',
    )
  })

  it('ignores Electron switches and unrelated files', () => {
    expect(findDocxPath(['SeuOffice Docs', '--inspect=document.docx', '/tmp/notes.txt'])).toBeNull()
  })

  it('finds legacy Word .doc/.dot arguments, which open as converted copies', () => {
    expect(findDocxPath(['SeuOffice Docs', '/tmp/legacy.doc'])).toBe('/tmp/legacy.doc')
    expect(findDocxPath(['SeuOffice Docs', '/tmp/TEMPLATE.DOT'])).toBe('/tmp/TEMPLATE.DOT')
  })
})

describe('isWord97Path', () => {
  it('tells the legacy Word binaries from the native and foreign formats', () => {
    expect(isWord97Path('/tmp/legacy.doc')).toBe(true)
    expect(isWord97Path('/tmp/TEMPLATE.DOT')).toBe(true)
    expect(isWord97Path('/tmp/report.docx')).toBe(false)
    expect(isWord97Path('/tmp/notes.odt')).toBe(false)
    expect(isWord97Path('/tmp/legacy.rtf')).toBe(false)
    expect(isWord97Path('/tmp/noextension')).toBe(false)
  })
})

describe('runGuardedCandidate', () => {
  it('chooses first and guards only once a candidate exists', async () => {
    const calls: string[] = []

    await expect(
      runGuardedCandidate(
        async () => {
          calls.push('guard')
          return true
        },
        async () => {
          calls.push('choose')
          return { path: '/tmp/candidate.docx' }
        },
        async (candidate) => {
          calls.push(`commit:${candidate.path}`)
        },
      ),
    ).resolves.toBe(true)

    expect(calls).toEqual(['choose', 'guard', 'commit:/tmp/candidate.docx'])
  })

  it('never runs the guard when the picker is cancelled', async () => {
    const confirm = vi.fn(async () => true)
    const commit = vi.fn()

    await expect(runGuardedCandidate(confirm, async () => null, commit)).resolves.toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not commit a candidate when the replacement is rejected', async () => {
    const choose = vi.fn(async () => ({ path: '/tmp/candidate.docx' }))
    const commit = vi.fn()

    await expect(runGuardedCandidate(async () => false, choose, commit)).resolves.toBe(false)
    expect(choose).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('defers the guard for a candidate the caller marks as not a document yet', async () => {
    const confirm = vi.fn(async () => true)
    const commit = vi.fn()
    const encrypted = { needsPassword: true as const, path: '/tmp/locked.docx' }

    await expect(
      runGuardedCandidate(
        confirm,
        async () => encrypted,
        commit,
        (candidate) => !('needsPassword' in candidate),
      ),
    ).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith(encrypted)
  })
})

describe('runGuardedDocumentAction', () => {
  it('keeps the current document when the replacement guard is canceled', async () => {
    const replace = vi.fn()

    await expect(runGuardedDocumentAction(async () => false, replace)).resolves.toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it('runs the replacement only after the guard accepts', async () => {
    const calls: string[] = []

    await expect(
      runGuardedDocumentAction(
        async () => {
          calls.push('guard')
          return true
        },
        async () => {
          calls.push('replace')
        },
      ),
    ).resolves.toBe(true)
    expect(calls).toEqual(['guard', 'replace'])
  })
})
