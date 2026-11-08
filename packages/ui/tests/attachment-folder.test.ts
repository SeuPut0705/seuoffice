import { describe, expect, it } from 'vitest'
import { attachmentFolderLabel } from '../src/attachment-folder'

describe('attachmentFolderLabel', () => {
  it('names the folder directly containing a Windows path', () => {
    expect(attachmentFolderLabel('C:\\Users\\a\\2학기\\계획서.docx')).toBe('2학기')
  })

  it('names the folder directly containing a POSIX path', () => {
    expect(attachmentFolderLabel('/home/a/1학기/계획서.docx')).toBe('1학기')
  })

  it('treats both separators alike, mixed in one path', () => {
    expect(attachmentFolderLabel('C:/Users\\a/2학기\\계획서.docx')).toBe('2학기')
    expect(attachmentFolderLabel('/home/a\\1학기/계획서.docx')).toBe('1학기')
  })

  it('collapses repeated separators', () => {
    expect(attachmentFolderLabel('C:\\Users\\\\a\\\\2학기\\\\계획서.docx')).toBe('2학기')
  })

  it('has no folder for a file at a drive or filesystem root', () => {
    expect(attachmentFolderLabel('C:\\a.docx')).toBe('')
    expect(attachmentFolderLabel('C:/a.docx')).toBe('')
    expect(attachmentFolderLabel('d:\\a.docx')).toBe('')
    expect(attachmentFolderLabel('/a.docx')).toBe('')
  })

  it('has no folder for a bare file name or an empty string', () => {
    expect(attachmentFolderLabel('a.docx')).toBe('')
    expect(attachmentFolderLabel('')).toBe('')
  })

  it('names the share of a UNC path when the file sits in it', () => {
    expect(attachmentFolderLabel('\\\\server\\공유\\계획서.docx')).toBe('공유')
  })

  it('hides the id folder under an app-made Drive attachment folder', () => {
    expect(
      attachmentFolderLabel(
        'C:\\Users\\a\\AppData\\Local\\Temp\\ieumoffice-drive-attach\\3fa9c1\\계획서.docx',
      ),
    ).toBe('')
    expect(attachmentFolderLabel('/tmp/ieumoffice-drive-attach/3fa9c1/계획서.docx')).toBe('')
  })

  it('hides the file id folder under the Drive cache', () => {
    expect(
      attachmentFolderLabel(
        'C:\\Users\\a\\AppData\\Roaming\\IeumOffice\\drive-cache\\abc_123\\계획서.docx',
      ),
    ).toBe('')
    expect(
      attachmentFolderLabel('/home/a/.config/IeumOffice/drive-cache/abc_123/계획서.docx'),
    ).toBe('')
  })

  it('names a folder literally called drive-cache when it holds the file itself', () => {
    expect(attachmentFolderLabel('C:\\Users\\a\\drive-cache\\x.docx')).toBe('drive-cache')
    expect(attachmentFolderLabel('/home/a/drive-cache/x.docx')).toBe('drive-cache')
  })

  it('gives the same label for the same path every time', () => {
    const path = 'C:\\Users\\a\\2학기\\계획서.docx'
    expect(attachmentFolderLabel(path)).toBe(attachmentFolderLabel(path))
  })
})
