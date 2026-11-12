import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'

/**
 * Where a skill is used (decision 0122): the chooser on the skill card and
 * in Settings → Skills, the short line a settings row shows, and the
 * editors' names. `editor_<id>` keys follow `SKILL_EDITORS` in agent-core.
 */
const en = {
  label: 'Where it is used',
  all: 'Every editor',
  some: 'Only these editors',
  none: 'Choose at least one editor',
  checkAll: 'Check all',
  clearAll: 'Clear all',
  hintSome:
    'The AI panels of other editors do not list this skill, and the AI does not use it there',
  settingsNote: 'Kept in this PC’s settings only; the skill’s file stays as it is',
  summary: 'Used in: {editors}',
  changeFailed: 'Could not change where it is used',
  editor_docs: 'Docs',
  editor_sheets: 'Sheets',
  editor_slides: 'Slides',
  editor_hwp: 'HWP',
  editor_pdf: 'PDF',
  editor_markdown: 'Markdown',
  editor_html: 'HTML',
  editor_mindmap: 'Mind map',
  editor_epub: 'EPUB',
  editor_diagram: 'Diagram',
}

export const SKILL_EDITORS_STRINGS = defineStrings({
  en,
  ko: {
    label: '쓰는 곳',
    all: '모든 편집기',
    some: '고른 편집기만',
    none: '편집기를 하나 이상 고르세요',
    checkAll: '모두 고르기',
    clearAll: '모두 지우기',
    hintSome: '다른 편집기의 AI 창에는 이 스킬이 보이지 않고, AI도 쓰지 않습니다',
    settingsNote: '이 PC의 설정에만 적고, 스킬 파일은 바꾸지 않습니다',
    summary: '쓰는 곳: {editors}',
    changeFailed: '쓰는 곳을 바꾸지 못했습니다',
    editor_docs: '문서',
    editor_sheets: '스프레드시트',
    editor_slides: '프레젠테이션',
    editor_hwp: '한글',
    editor_pdf: 'PDF',
    editor_markdown: 'Markdown',
    editor_html: 'HTML',
    editor_mindmap: '마인드맵',
    editor_epub: 'EPUB',
    editor_diagram: '다이어그램',
  },
})

export type SkillEditorsStringKey = keyof typeof en

/** `skillEditorsText(lang, key, params?)`: one where-used string in that language */
export const skillEditorsText: (
  lang: Lang,
  key: SkillEditorsStringKey,
  params?: Record<string, string | number>,
) => string = createI18n(SKILL_EDITORS_STRINGS)
