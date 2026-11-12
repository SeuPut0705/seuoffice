import { createI18n, defineStrings, normalizeLang } from '@genoffice/i18n'

/**
 * Wording for the per-file recovery prompt (recovery-prompt.ts) and the notice
 * an editor shows once for a document that cannot get a recovery copy.
 *
 * `message` names the document through the `{name}` placeholder: when several
 * restored tabs ask in turn, the user must see which document each is about.
 * `fileChanged` is appended when the file on disk is newer than the copy.
 *
 * `en` defines the key set; every other language must cover exactly the same
 * keys (compile-time checked). Korean and English are written directly, the
 * other languages are translations.
 */
const en = {
  message: '“{name}” has unsaved changes.',
  detail:
    'Changes that were not saved last time were kept in a recovery copy. Restore them? Discard opens the file as it was last saved.',
  fileChanged:
    'The file has changed since the copy was made. Another program or a sync service may have edited it.',
  restore: 'Restore',
  discard: 'Discard',
  unprotectable:
    'This document is password-protected, so no recovery copy can be kept. If the app closes unexpectedly, unsaved changes cannot be recovered. Save often.',
}

type Keys = Record<keyof typeof en, string>

export const RECOVERY_PROMPT_STRINGS = defineStrings({
  en,
  ko: {
    message: '“{name}”에 저장하지 않은 내용이 남아 있습니다.',
    detail:
      '지난번에 저장하지 않은 내용이 복구 사본에 남아 있습니다. 되살릴까요? 버리면 마지막으로 저장한 파일 내용으로 엽니다.',
    fileChanged:
      '사본을 만든 뒤에 파일이 바뀌었습니다. 다른 프로그램이나 동기화 서비스가 고쳤을 수 있습니다.',
    restore: '되살리기',
    discard: '버리기',
    unprotectable:
      '암호가 걸린 문서라 복구 사본을 만들 수 없습니다. 앱이 갑자기 꺼지면 저장하지 않은 내용을 되살릴 수 없으니 자주 저장하세요.',
  } satisfies Keys,
})

const t = createI18n(RECOVERY_PROMPT_STRINGS)

export interface RecoveryPromptLabels {
  /** names the document */
  message: string
  detail: string
  /** extra line when the file on disk is newer than the copy */
  fileChanged: string
  restore: string
  discard: string
}

/** the prompt's strings in the given UI language (raw locale tags accepted) */
export function recoveryPromptLabels(lang: string, documentName: string): RecoveryPromptLabels {
  const loc = normalizeLang(lang)
  return {
    message: t(loc, 'message', { name: documentName }),
    detail: t(loc, 'detail'),
    fileChanged: t(loc, 'fileChanged'),
    restore: t(loc, 'restore'),
    discard: t(loc, 'discard'),
  }
}

/**
 * The notice an editor shows once, when a tab first opens a document that
 * cannot get a recovery copy (password Excel, HWP or PDF).
 */
export function unprotectableNoticeText(lang: string): string {
  return t(normalizeLang(lang), 'unprotectable')
}
