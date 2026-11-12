/**
 * Texts the main process shows itself: the save dialog (with the Save As
 * export types) and the question before closing a map with unsaved changes.
 * Everything else the user reads is in the renderer's dictionaries.
 */
import { createI18n, getUiLang } from '@seuoffice/i18n'

const tDlg = createI18n({
  en: {
    dlgSaveTitle: 'Save Mind Map',
    filterMindmap: 'Mind Maps',
    filterPng: 'PNG Image',
    filterSvg: 'SVG Image',
    filterPdf: 'PDF Documents',
    filterOutline: 'Markdown Outline',
    untitledFile: 'Untitled',
    closeUnsavedMsg: 'This document has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
  },
  ko: {
    dlgSaveTitle: '마인드맵 저장',
    filterMindmap: '마인드맵',
    filterPng: 'PNG 이미지',
    filterSvg: 'SVG 이미지',
    filterPdf: 'PDF 문서',
    filterOutline: '마크다운 개요',
    untitledFile: '제목 없음',
    closeUnsavedMsg: '이 문서에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
  },
})

export type MainTextKey =
  | 'dlgSaveTitle'
  | 'filterMindmap'
  | 'filterPng'
  | 'filterSvg'
  | 'filterPdf'
  | 'filterOutline'
  | 'untitledFile'
  | 'closeUnsavedMsg'
  | 'closeUnsavedDetail'
  | 'btnSave'
  | 'btnDontSave'
  | 'btnCancel'

/** A text of the main process in the language the app currently shows. */
export function tm(key: MainTextKey): string {
  return tDlg(getUiLang(), key)
}
