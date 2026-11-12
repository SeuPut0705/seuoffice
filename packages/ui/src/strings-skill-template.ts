import { createI18n, defineStrings, type Lang } from '@seuoffice/i18n'

/**
 * The template flow of the person's skills (spec 5.6, 5.7): a template skill
 * run in a new tab, the template preview tab and its card buttons.
 */
const en = {
  takenOver: 'Working with the template in a new tab',
  goToTab: 'Go to the tab',
  firstTemplateOnly: 'Using the template of {title}',
  templateMissing: 'The template file of the {title} skill is missing',
  openWithTemplate: 'Open a new document from this template',
  openFailed: 'The template could not be opened in a new tab',
  previewTabTitle: 'Template preview - {title}',
  previewContinues: 'Continues in the template preview tab',
  saveThisTab: 'Save this tab as the template',
  asIsRedacted: 'The document has hidden (redacted) parts, so it cannot be saved as it is',
  clearRequest:
    'Turn this document into a reusable template. Clear the filled-in values (names, dates, personal information, content used only this once) and keep the form itself (headings, tables, items and formatting) as it is.',
  handoffNotSent: 'A handed-over skill could not be read, so the request was not sent',
  documentUnreadable: 'The current document could not be read',
  untitled: 'Untitled',
  chooseWhere: 'This document already has content. Where should the skill work?',
  runHere: 'Do it in this document',
  openNewWithCurrent: 'New document from the template (attach this one)',
  needsSave: 'Save this document first to attach it to the new document, then press again.',
  openWithoutAttach: 'Open without attaching',
  notAttachedEditor:
    'The editor this template opens in takes no attachments, so this document was not attached',
  attachFailed: 'The handed-over document could not be attached, so the request was not sent',
}

export const SKILL_TEMPLATE_STRINGS = defineStrings({
  en,
  ko: {
    takenOver: '새 탭에서 양식으로 작업합니다',
    goToTab: '탭으로 가기',
    firstTemplateOnly: '양식은 {title}의 것을 씁니다',
    templateMissing: '{title} 스킬의 양식 파일이 없습니다',
    openWithTemplate: '이 양식으로 새 문서 열기',
    openFailed: '양식을 새 탭에 열지 못했습니다',
    previewTabTitle: '양식 미리보기 - {title}',
    previewContinues: '양식 미리보기 탭에서 이어집니다',
    saveThisTab: '이 탭을 양식으로 저장',
    asIsRedacted: '문서에 가린 내용이 있어 원래 문서 그대로 저장할 수 없습니다',
    clearRequest:
      '이 문서를 되풀이해 쓸 수 있는 양식으로 만들어 주세요. 채워진 값(이름, 날짜, 개인정보, 이번에만 쓰인 내용)은 비우고, 양식 모양(제목, 표, 항목, 서식)은 그대로 두세요.',
    handoffNotSent: '넘겨받은 스킬을 읽지 못해 요청을 보내지 않았습니다',
    documentUnreadable: '지금 문서를 읽지 못했습니다',
    untitled: '제목 없음',
    chooseWhere: '지금 문서에 내용이 있습니다. 어디에서 할까요?',
    runHere: '지금 문서에서 하기',
    openNewWithCurrent: '양식으로 새 문서 열기(지금 문서 붙임)',
    needsSave: '새 문서에 붙이려면 지금 문서를 먼저 저장해야 합니다. 저장한 뒤 다시 누르세요.',
    openWithoutAttach: '붙이지 않고 열기',
    notAttachedEditor: '이 양식을 여는 편집기는 첨부를 받지 않아 지금 문서를 붙이지 않았습니다',
    attachFailed: '넘겨받은 문서를 붙이지 못해 요청을 보내지 않았습니다',
  },
})

export type SkillTemplateStringKey = keyof typeof en

/** `skillTemplateText(lang, key, params?)`: one template-flow string in that language */
export const skillTemplateText: (
  lang: Lang,
  key: SkillTemplateStringKey,
  params?: Record<string, string | number>,
) => string = createI18n(SKILL_TEMPLATE_STRINGS)
