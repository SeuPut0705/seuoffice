import { createI18n, defineStrings } from '@genoffice/i18n'

/**
 * Text the main process shows for Google Drive: the page the browser shows
 * after the Google sign-in, and the dialogs about saving back to Drive.
 * `en` defines the key set.
 */
const en = {
  pageDoneTitle: 'Google Drive is connected',
  pageDoneBody: 'You can close this tab and go back to GenOffice.',
  pageFailedTitle: 'Google Drive was not connected',
  pageFailedBody: 'Go back to GenOffice and try again.',
  dialogTitle: 'Google Drive',
  askChanged: '“{name}” was changed in Google Drive after you opened it.',
  askReadOnly: 'You can’t edit “{name}” in Google Drive.',
  askGone: '“{name}” is no longer in Google Drive, or this account can’t see it.',
  askDetail: 'Your changes are saved on this PC. What should happen in Drive?',
  btnOverwrite: 'Overwrite it in Drive',
  btnCopy: 'Save a copy to Drive',
  btnLocal: 'Keep on this PC only',
  copySuffix: 'copy',
  noticeOfficeCopy:
    '“{name}” is a Google document, so it was left as it is. Your changes were saved to Google Drive as “{copyName}”.',
  noticeCopy: 'Your changes were saved to Google Drive as “{copyName}”.',
  noticeUploadFailed:
    '“{name}” could not be uploaded to Google Drive. Your changes are saved on this PC, and the app will try again.',
  pagePickedTitle: 'Files chosen',
  pagePickedBody: 'You can close this tab and go back to GenOffice.',
  freeAiDocRefusal:
    'This document is a copy of a Google Drive file, and the AI in use is a free connection that may train on what it receives. Choose another AI to work on this document.',
  ok: 'OK',
}

type Keys = Record<keyof typeof en, string>

export const DRIVE_MAIN_STRINGS = defineStrings({
  en,
  ko: {
    pageDoneTitle: 'Google 드라이브를 연결했습니다',
    pageDoneBody: '이 탭을 닫고 GenOffice로 돌아가세요.',
    pageFailedTitle: 'Google 드라이브를 연결하지 못했습니다',
    pageFailedBody: 'GenOffice로 돌아가 다시 시도하세요.',
    dialogTitle: 'Google 드라이브',
    askChanged: '“{name}”을(를) 연 뒤에 Google 드라이브에서 누군가 고쳤습니다.',
    askReadOnly: 'Google 드라이브에서 “{name}”을(를) 고칠 권한이 없습니다.',
    askGone: '“{name}”이(가) Google 드라이브에 없거나, 이 계정으로는 볼 수 없습니다.',
    askDetail: '고친 내용은 이 PC에 저장돼 있습니다. 드라이브는 어떻게 할까요?',
    btnOverwrite: '드라이브의 파일 덮어쓰기',
    btnCopy: '드라이브에 사본으로 저장',
    btnLocal: '이 PC에만 저장',
    copySuffix: '사본',
    noticeOfficeCopy:
      '“{name}”은(는) Google 문서라서 그대로 두었습니다. 고친 내용은 Google 드라이브에 “{copyName}”(으)로 저장했습니다.',
    noticeCopy: '고친 내용을 Google 드라이브에 “{copyName}”(으)로 저장했습니다.',
    noticeUploadFailed:
      '“{name}”을(를) Google 드라이브에 올리지 못했습니다. 고친 내용은 이 PC에 저장돼 있고, 앱이 다시 올려 봅니다.',
    pagePickedTitle: '파일을 골랐습니다',
    pagePickedBody: '이 탭을 닫고 GenOffice로 돌아가세요.',
    freeAiDocRefusal:
      '이 문서는 Google 드라이브 파일의 사본이고, 지금 쓰는 AI는 받은 내용을 학습에 쓸 수 있는 무료 연결입니다. 이 문서는 다른 AI를 골라 맡기세요.',
    ok: '확인',
  } satisfies Keys,
})

export const driveText = createI18n(DRIVE_MAIN_STRINGS)

/** "report (copy).docx": the suffix goes before the extension */
export function copyFileName(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`
}
