import { createI18n, defineStrings, type Lang } from '@seuoffice/i18n'

/**
 * The published feedback survey (Google Forms, owned by the repository owner).
 * The Help menu and Settings → About open it in the user's browser; the app
 * itself sends nothing. Changing the form's questions does not change this
 * address, so the link stays valid as the survey is edited.
 */
export const FEEDBACK_SURVEY_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSfD_dlKfi_ZkcjBJFTH3S2nldTIoW0cMI9d_yDaEe6DwKY47A/viewform'

const en = {
  menuLabel: 'Send feedback',
  dialogTitle: 'Send feedback',
  dialogBody:
    'The survey opens in your browser. The details below are copied to the clipboard so you can paste them into the survey. The app sends nothing itself, and document contents are never included.',
  details: 'Version {version}\nOS {os}\nUI language {language}',
  btnOpen: 'Open survey',
  btnCancel: 'Cancel',
}

type Keys = Record<keyof typeof en, string>

export const FEEDBACK_STRINGS = defineStrings({
  en,
  ko: {
    menuLabel: '의견 보내기',
    dialogTitle: '의견 보내기',
    dialogBody:
      '설문이 브라우저에서 열립니다. 아래 정보는 클립보드에 복사되어 설문에 붙여 넣을 수 있습니다. 앱은 아무것도 보내지 않으며, 문서 내용은 포함되지 않습니다.',
    details: '버전 {version}\n운영체제 {os}\n화면 언어 {language}',
    btnOpen: '설문 열기',
    btnCancel: '취소',
  } satisfies Keys,
})

export const feedbackText = createI18n(FEEDBACK_STRINGS)

export interface FeedbackEnvironment {
  version: string
  os: string
  language: string
}

/** `Windows`, `macOS`, `Linux`; anything else is shown as the platform names itself. */
export function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

/** The block copied to the clipboard: version, OS and UI language, nothing else. */
export function feedbackDetails(lang: Lang, env: FeedbackEnvironment): string {
  return feedbackText(lang, 'details', {
    version: env.version,
    os: env.os,
    language: env.language,
  })
}
