/**
 * Texts the main process shows itself: the save dialogs and the question
 * before closing a book with unsaved changes. Everything else the user reads
 * is in the renderer's dictionaries.
 */
import { createI18n, getUiLang } from '@genoffice/i18n'

const tDlg = createI18n({
  en: {
    dlgSaveTitle: 'Save E-book',
    filterEpub: 'EPUB E-books',
    dlgSaveTranslatedTitle: 'Save Translated Book',
    dlgSaveBilingualTitle: 'Save Bilingual Book',
    closeUnsavedMsg: 'This document has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
  },
  ko: {
    dlgSaveTitle: '전자책 저장',
    filterEpub: 'EPUB 전자책',
    dlgSaveTranslatedTitle: '번역본 저장',
    dlgSaveBilingualTitle: '대역본 저장',
    closeUnsavedMsg: '이 문서에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
  },
})

export type MainTextKey =
  | 'dlgSaveTitle'
  | 'filterEpub'
  | 'dlgSaveTranslatedTitle'
  | 'dlgSaveBilingualTitle'
  | 'closeUnsavedMsg'
  | 'closeUnsavedDetail'
  | 'btnSave'
  | 'btnDontSave'
  | 'btnCancel'

/** A text of the main process in the language the app currently shows. */
export function tm(key: MainTextKey): string {
  return tDlg(getUiLang(), key)
}
