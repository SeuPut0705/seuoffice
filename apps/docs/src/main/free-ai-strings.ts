import { defineStrings } from '@genoffice/i18n'

/**
 * The page the browser shows after the OpenRouter sign-in hands it back to
 * this PC. `en` defines the key set.
 */
const en = {
  pageDoneTitle: 'Connected to GenOffice',
  pageDoneBody: 'You can close this tab and go back to the app.',
  pageFailedTitle: 'The connection was not made',
  pageFailedBody: 'Go back to the app and try again.',
}

type Keys = Record<keyof typeof en, string>

export const FREE_AI_PAGE_STRINGS = defineStrings({
  en,
  ko: {
    pageDoneTitle: 'GenOffice에 연결됐습니다',
    pageDoneBody: '이 탭을 닫고 앱으로 돌아가세요.',
    pageFailedTitle: '연결하지 못했습니다',
    pageFailedBody: '앱으로 돌아가 다시 시도하세요.',
  } satisfies Keys,
})
