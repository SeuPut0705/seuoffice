import { createI18n, defineStrings, type Lang } from '@seuoffice/i18n'

/**
 * The AI panel's skill list (`/` and `$`), the skill chips and the lines
 * beside them. Source labels name the folders in plain text only.
 */
const en = {
  listLabel: 'Skills',
  manage: 'Manage skills…',
  template: 'Includes a template',
  scriptsNotice: 'This skill’s scripts do not run in the regular AI panel',
  mcpServerNeeded: 'MCP server needed: {servers}',
  tooLarge: 'The skills are too large to send along',
  missing: 'Unavailable',
  missingNotice: 'A skill could not be found, so nothing was sent. Remove it and send again.',
  removeChip: 'Remove {title}',
  sourceBuiltin: 'Built-in',
  sourceApp: 'My skills',
  sourceAppGitHub: 'My skills · GitHub',
  sourceUser: 'Claude skills folder',
  sourcePlugin: 'Claude plugin · {plugin}',
  sourceCodex: 'Codex skills folder',
}

export const SKILL_PICKER_STRINGS = defineStrings({
  en,
  ko: {
    listLabel: '스킬',
    manage: '스킬 관리…',
    template: '양식 포함',
    scriptsNotice: '이 스킬의 스크립트는 일반 AI 창에서 실행되지 않습니다',
    mcpServerNeeded: 'MCP 서버 필요: {servers}',
    tooLarge: '스킬이 너무 커서 함께 보낼 수 없습니다',
    missing: '없음',
    missingNotice: '스킬을 찾을 수 없어 보내지 않았습니다. 그 스킬을 빼고 다시 보내세요.',
    removeChip: '{title} 빼기',
    sourceBuiltin: '기본',
    sourceApp: '내 스킬',
    sourceAppGitHub: '내 스킬 · 깃허브',
    sourceUser: 'Claude 스킬 폴더',
    sourcePlugin: 'Claude 플러그인 · {plugin}',
    sourceCodex: 'Codex 스킬 폴더',
  },
})

export type SkillPickerStringKey = keyof typeof en

/** `skillPickerText(lang, key, params?)`: one skill-list string in that language */
export const skillPickerText: (
  lang: Lang,
  key: SkillPickerStringKey,
  params?: Record<string, string | number>,
) => string = createI18n(SKILL_PICKER_STRINGS)
