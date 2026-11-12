import { createI18n, defineStrings, type Lang } from '@seuoffice/i18n'

/**
 * The tool rows of the project folder tools in an AI panel (spec 5.5, 5.6):
 * what the AI looked at in the project, and the memory it wrote. The model
 * sees its own English tool texts; these are only what the person reads.
 */
const en = {
  toolListFiles: 'Looked at the project’s file list',
  toolSearch: 'Searched the project: {query}',
  toolRead: 'Read: {path}',
  toolReadFailed: 'Could not read: {path}',
  toolRemembered: 'Remembered: {text}',
  toolMemoryChanged: 'Memory changed: {text}',
  toolMemoryRemoved: 'Memory removed: {text}',
  toolRememberFailed: 'Could not remember: {text}',
}

export const PROJECT_CHAT_STRINGS = defineStrings({
  en,
  ko: {
    toolListFiles: '프로젝트 파일 목록을 봤습니다',
    toolSearch: '프로젝트에서 찾음: {query}',
    toolRead: '읽음: {path}',
    toolReadFailed: '읽지 못함: {path}',
    toolRemembered: '기억함: {text}',
    toolMemoryChanged: '기억 고침: {text}',
    toolMemoryRemoved: '기억 지움: {text}',
    toolRememberFailed: '기억하지 못함: {text}',
  },
})

export type ProjectChatStringKey = keyof typeof en

/** `projectChatText(lang, key, params?)`: one project tool-row string in that language */
export const projectChatText: (
  lang: Lang,
  key: ProjectChatStringKey,
  params?: Record<string, string | number>,
) => string = createI18n(PROJECT_CHAT_STRINGS)
