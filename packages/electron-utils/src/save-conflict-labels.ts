import { createI18n, defineStrings, normalizeLang } from '@genoffice/i18n'

/**
 * Wording for the same-document save conflict prompt raised by
 * save-conflict.ts. The disk version the prompt talks about may have been
 * written by a sibling copy of the document (the split view) or by another
 * program, so the sentence says "changed elsewhere" rather than naming a
 * program. The Word editor keeps its own older wording for external changes
 * (apps/docs `extModifiedMsg`/`extModifiedDetail`).
 *
 * Going through createI18n keeps the repo conventions: the product name is
 * swapped into the template at output time.
 *
 * `en` defines the key set; every other language must cover exactly the same
 * keys (compile-time checked).
 */
const en = {
  message: 'This document has changed elsewhere.',
  detail: 'Save anyway and overwrite the changes on disk?',
  overwrite: 'Overwrite',
  cancel: 'Cancel',
}

type Keys = Record<keyof typeof en, string>

export const SAVE_CONFLICT_STRINGS = defineStrings({
  en,
  ko: {
    message: '이 문서가 다른 곳에서 바뀌었습니다.',
    detail: '그래도 저장하여 디스크의 변경 사항을 덮어쓸까요?',
    overwrite: '덮어쓰기',
    cancel: '취소',
  } satisfies Keys,
})

const t = createI18n(SAVE_CONFLICT_STRINGS)

export interface SaveConflictLabels {
  message: string
  detail: string
  overwrite: string
  cancel: string
}

/** The four prompt strings in the given UI language (raw locale tags accepted). */
export function saveConflictLabels(lang: string): SaveConflictLabels {
  const loc = normalizeLang(lang)
  return {
    message: t(loc, 'message'),
    detail: t(loc, 'detail'),
    overwrite: t(loc, 'overwrite'),
    cancel: t(loc, 'cancel'),
  }
}
