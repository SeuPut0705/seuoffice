import { describe, expect, it } from 'vitest'
import type { AttachmentMeta } from '../src/shared/desktop-api'
import { createFilesSkill } from '../src/renderer/ai/files-skill'

/** The attachment list the model reads each turn, split into lines. */
function listLines(list: AttachmentMeta[]): string[] {
  return (createFilesSkill(() => list).buildContext?.() ?? '').split('\n')
}

const att = (path: string, name: string, ext: string, sizeBytes: number): AttachmentMeta => ({
  path,
  name,
  ext,
  sizeBytes,
})

const PLAN_FALL = att('C:\\work\\2학기\\계획서.docx', '계획서.docx', 'docx', 120 * 1024)
const PLAN_SPRING = att('C:/work/1학기/계획서.docx', '계획서.docx', 'docx', 98 * 1024)
const MINUTES = att('C:\\work\\회의\\회의록.hwpx', '회의록.hwpx', 'hwpx', 40 * 1024)

describe('attachment list: folder names for same-named attachments', () => {
  it('names the folder on every line whose file name another attachment shares', () => {
    expect(listLines([PLAN_FALL, PLAN_SPRING, MINUTES])).toEqual([
      'Attachment list (index | file name | type | size):',
      '0 | 계획서.docx (folder: 2학기) | .docx | 120KB',
      '1 | 계획서.docx (folder: 1학기) | .docx | 98KB',
      '2 | 회의록.hwpx | .hwpx | 40KB',
    ])
  })

  it('keeps the lines of attachments with distinct names exactly as before', () => {
    expect(listLines([PLAN_FALL, MINUTES])).toEqual([
      'Attachment list (index | file name | type | size):',
      '0 | 계획서.docx | .docx | 120KB',
      '1 | 회의록.hwpx | .hwpx | 40KB',
    ])
  })

  it('treats names that differ only in case as the same name', () => {
    expect(
      listLines([
        att('/home/me/drafts/Report.docx', 'Report.docx', 'docx', 900),
        att('/home/me/final/report.docx', 'report.docx', 'docx', 3 * 1024 * 1024),
      ]),
    ).toEqual([
      'Attachment list (index | file name | type | size):',
      '0 | Report.docx (folder: drafts) | .docx | 900B',
      '1 | report.docx (folder: final) | .docx | 3.0MB',
    ])
  })

  it('adds no folder for copies inside the folders the app makes for Drive files', () => {
    expect(
      listLines([
        att('C:\\Temp\\ieumoffice-drive-attach\\k3j9x\\x.docx', 'x.docx', 'docx', 2048),
        att('/Users/me/Library/IeumOffice/drive-cache/1AbCdE/x.docx', 'x.docx', 'docx', 2048),
      ]),
    ).toEqual([
      'Attachment list (index | file name | type | size):',
      '0 | x.docx | .docx | 2KB',
      '1 | x.docx | .docx | 2KB',
    ])
  })

  it('sends only the one folder name, never the rest of the path', () => {
    const context = listLines([PLAN_FALL, PLAN_SPRING]).join('\n')
    expect(context).not.toContain('work')
    expect(context).not.toContain('C:')
  })
})
