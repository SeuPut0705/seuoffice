import { createI18n, getUiLang } from '@seuoffice/i18n'

/** Text the main process shows or hands back: the save dialogs, the unsaved-changes prompt, and attachment errors. */
const tDlg = createI18n({
  en: {
    dlgSaveTitle: 'Save HWP Document',
    untitledFile: 'Untitled',
    dlgExportPdfTitle: 'Export as PDF',
    filterHwp: 'HWP Documents (HWP)',
    filterHwpx: 'HWP Documents (HWPX)',
    filterPdf: 'PDF Documents',
    closeUnsavedMsg: 'This document has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
    closeMemoMsg: 'A memo you are writing is still open.',
    closeMemoDetail:
      'Its text is not in the document yet. Discard it, along with any unsaved changes, and close?',
    btnDiscardClose: 'Discard and Close',
    dlgAddAttachment: 'Add Attachments',
    filterSupported: 'Supported Files',
    filterAll: 'All Files',
    errUnsupportedExt: '.{ext} files are not supported',
    errNotFile: 'not a file',
    errTooLarge: 'exceeds the {mb}MB limit',
    errImageTooLarge: 'image exceeds the 5MB limit',
    errUnreadable: 'cannot be read',
    errFileTooLarge: 'File exceeds the size limit',
    errParseFailed: 'Failed to parse file',
    errImageNoText: 'Image attachments have no text; the image is sent along with the user message',
    errNotImage: 'not a supported image type',
  },
  ko: {
    dlgSaveTitle: '한글 문서 저장',
    untitledFile: '제목 없음',
    dlgExportPdfTitle: 'PDF로 내보내기',
    filterHwp: '한글 문서 (HWP)',
    filterHwpx: '한글 문서 (HWPX)',
    filterPdf: 'PDF 문서',
    closeUnsavedMsg: '이 문서에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
    closeMemoMsg: '작성 중인 메모 창이 열려 있습니다.',
    closeMemoDetail:
      '메모 내용은 아직 문서에 들어가지 않았습니다. 메모와 저장하지 않은 변경 사항을 버리고 닫을까요?',
    btnDiscardClose: '버리고 닫기',
    dlgAddAttachment: '첨부 파일 추가',
    filterSupported: '지원되는 파일',
    filterAll: '모든 파일',
    errUnsupportedExt: '.{ext} 형식은 지원되지 않습니다',
    errNotFile: '파일이 아닙니다',
    errTooLarge: '{mb}MB 제한을 초과했습니다',
    errImageTooLarge: '이미지가 5MB 제한을 초과했습니다',
    errUnreadable: '읽을 수 없습니다',
    errFileTooLarge: '파일이 크기 제한을 초과했습니다',
    errParseFailed: '파일을 분석하지 못했습니다',
    errImageNoText:
      '이미지 첨부 파일은 텍스트를 제공하지 않으며, 이미지 형태로 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하면 됩니다',
    errNotImage: '지원되지 않는 이미지 형식입니다',
  },
})

export type DlgKey =
  | 'dlgSaveTitle'
  | 'untitledFile'
  | 'dlgExportPdfTitle'
  | 'filterHwp'
  | 'filterHwpx'
  | 'filterPdf'
  | 'closeUnsavedMsg'
  | 'closeUnsavedDetail'
  | 'btnSave'
  | 'btnDontSave'
  | 'btnCancel'
  | 'closeMemoMsg'
  | 'closeMemoDetail'
  | 'btnDiscardClose'
  | 'dlgAddAttachment'
  | 'filterSupported'
  | 'filterAll'
  | 'errUnsupportedExt'
  | 'errNotFile'
  | 'errTooLarge'
  | 'errImageTooLarge'
  | 'errUnreadable'
  | 'errFileTooLarge'
  | 'errParseFailed'
  | 'errImageNoText'
  | 'errNotImage'

export const tm = (key: DlgKey, vars?: Record<string, string | number>): string =>
  tDlg(getUiLang(), key, vars)
