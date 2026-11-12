import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'

/**
 * The AI input's `@` document list: its name, the group labels (the project's
 * files are spec 5.13), why a row cannot be picked, and the row that opens the
 * document picker window.
 */
const en = {
  listLabel: 'Documents',
  groupPane: 'Other pane',
  groupOpen: 'Open documents',
  groupProject: 'Files in this project',
  groupRecent: 'Recent documents',
  reasonModified: 'Save it to attach',
  reasonUnsaved: 'New document, not saved yet',
  more: 'Find more…',
}

export const DOC_MENTION_STRINGS = defineStrings({
  en,
  ko: {
    listLabel: '문서',
    groupPane: '옆 칸',
    groupOpen: '열린 문서',
    groupProject: '이 프로젝트의 파일',
    groupRecent: '최근 문서',
    reasonModified: '저장하면 붙일 수 있어요',
    reasonUnsaved: '저장 안 한 새 문서',
    more: '더 찾아보기…',
  },
})

export type DocMentionStringKey = keyof typeof en

/** `docMentionText(lang, key)`: one `@` document-list string in that language */
export const docMentionText: (
  lang: Lang,
  key: DocMentionStringKey,
  params?: Record<string, string | number>,
) => string = createI18n(DOC_MENTION_STRINGS)
