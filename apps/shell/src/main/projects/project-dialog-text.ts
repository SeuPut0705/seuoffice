import type { MessageBoxOptions, OpenDialogOptions } from 'electron'
import { createI18n, defineStrings, type Lang } from '@seuoffice/i18n'
import type { ProjectTrustAnswer, ProjectTrustPrompt } from '@seuoffice/project-store'

/**
 * The shell main process's project folder dialogs (decision 0088): the
 * first-time trust prompt (spec 5.10), the download question for a file that
 * is not on this PC (spec 5.8), "use this folder as the project?" for a new
 * project and the folder pickers (spec 5.1). Only the texts and the dialog options live here, so they are testable
 * without Electron; `index.ts` shows them parented to the asking window.
 */

const en = {
  trustTitle: 'Use the instructions in this folder?',
  trustMessage:
    'The folder “{name}” holds instructions, memory or chats that the app on this PC did not write.',
  trustHint:
    'Read them, then choose. With “Use without instructions” the AI uses only the folder’s files and this PC’s chats.',
  trustInstructions: 'Instructions (instructions.md)',
  trustMemory: 'Memory (memory.md)',
  trustForeignChats: 'Chats written on other PCs',
  trustMoreChats: '…and {count} more',
  chatUntitled: '(untitled)',
  trustUse: 'Use with instructions',
  trustWithout: 'Use without instructions',
  cancel: 'Cancel',
  trustViewAll: 'View all',
  trustViewHint:
    '“View all” opens the files in the app. Come back to this window when you have read them and the question appears again.',
  trustMoreChars: '({count} more characters)',
  downloadTitle: 'File not on this PC',
  downloadMessage: '“{file}” is not on this PC and has to be downloaded. Download it?',
  downloadButton: 'Download',
  newProjectTitle: 'New project',
  useExistingMessage: 'A folder named “{name}” already exists. Use that folder as the project?',
  useExistingButton: 'Use this folder',
  pickFolderTitle: 'Choose a folder to use as a project',
  relocateTitle: 'Choose the project folder again',
  pickParentTitle: 'Choose where to create the new project',
  pickFolderButton: 'Choose',
}

type Keys = Record<keyof typeof en, string>

export const PROJECT_DIALOG_STRINGS = defineStrings({
  en,
  ko: {
    trustTitle: '이 폴더의 지침을 사용할까요?',
    trustMessage: '‘{name}’ 폴더에 이 PC의 앱이 쓰지 않은 지침·기억·대화가 있습니다.',
    trustHint:
      '읽어 보고 고르세요. [지침 없이 사용]을 고르면 AI는 폴더의 파일과 이 PC의 대화만 씁니다.',
    trustInstructions: '지침 (instructions.md)',
    trustMemory: '기억 (memory.md)',
    trustForeignChats: '다른 PC에서 쓴 대화',
    trustMoreChats: '…그 밖에 {count}개',
    chatUntitled: '(제목 없음)',
    trustUse: '지침까지 사용',
    trustWithout: '지침 없이 사용',
    cancel: '취소',
    trustViewAll: '전체 보기',
    trustViewHint:
      '[전체 보기]를 누르면 파일을 앱에서 엽니다. 다 읽고 이 화면으로 돌아오면 다시 묻습니다.',
    trustMoreChars: '({count}자 더 있음)',
    downloadTitle: 'PC에 없는 파일',
    downloadMessage: '‘{file}’은 PC에 없어 내려받아야 합니다. 내려받을까요?',
    downloadButton: '내려받기',
    newProjectTitle: '새 프로젝트',
    useExistingMessage: '‘{name}’ 폴더가 이미 있습니다. 그 폴더를 프로젝트로 사용할까요?',
    useExistingButton: '이 폴더 사용',
    pickFolderTitle: '프로젝트로 쓸 폴더 고르기',
    relocateTitle: '프로젝트 폴더 다시 고르기',
    pickParentTitle: '새 프로젝트를 만들 곳 고르기',
    pickFolderButton: '고르기',
  } satisfies Keys,
})

export const projectDialogText = createI18n(PROJECT_DIALOG_STRINGS)

/** Characters of each file the trust prompt shows; the rest is counted ("N more characters") */
export const TRUST_TEXT_SHOWN_CHARS = 1_500

/** Chats from other PCs the trust prompt lists by name; the rest are counted */
export const TRUST_CHATS_SHOWN = 20

/** `text` cut to `max` characters (whole code points) with an ellipsis */
export function shownText(text: string, max = TRUST_TEXT_SHOWN_CHARS): string {
  return shownExcerpt(text, max).text
}

/** `text` trimmed and cut to `max` whole characters, and how many characters were left out */
export function shownExcerpt(
  text: string,
  max = TRUST_TEXT_SHOWN_CHARS,
): { text: string; more: number } {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return { text: chars.join(''), more: 0 }
  return { text: `${chars.slice(0, max).join('')}…`, more: chars.length - max }
}

function shownCount(count: number, lang: Lang): string {
  try {
    return new Intl.NumberFormat(lang).format(count)
  } catch {
    return String(count)
  }
}

function shownDate(iso: string, lang: Lang): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  } catch {
    return at.toISOString()
  }
}

/**
 * What the person picked in the trust prompt: the answer, or `view` for
 * [view all] (open the files, then ask again). null: closed or cancelled.
 */
export type ProjectTrustChoice = ProjectTrustAnswer | 'view'

/** The response index of each trust prompt button */
const TRUST_USE = 0
const TRUST_WITHOUT = 1
const TRUST_VIEW = 2
const TRUST_CANCEL = 3

/**
 * The first-time trust prompt (spec 5.10): the texts this install did not
 * write (each cut to its first `TRUST_TEXT_SHOWN_CHARS` characters with "N
 * more characters") and the chats from other PCs, with [use] / [use without
 * instructions] / [view all] / [cancel]. Cancel is the default and what closing
 * means.
 */
export function trustPromptOptions(lang: Lang, prompt: ProjectTrustPrompt): MessageBoxOptions {
  const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
    projectDialogText(lang, key, params)
  const parts: string[] = [t('trustHint'), t('trustViewHint'), prompt.folderPath]
  const section = (label: string, text: string | null) => {
    if (text === null || !text.trim()) return
    const shown = shownExcerpt(text)
    const more =
      shown.more > 0 ? `\n${t('trustMoreChars', { count: shownCount(shown.more, lang) })}` : ''
    parts.push(`— ${label} —\n${shown.text}${more}`)
  }
  section(t('trustInstructions'), prompt.instructions)
  section(t('trustMemory'), prompt.memory)
  section('AGENTS.md', prompt.agents)
  section('CLAUDE.md', prompt.claude)
  if (prompt.foreignChats.length > 0) {
    const lines = prompt.foreignChats
      .slice(0, TRUST_CHATS_SHOWN)
      .map(
        (chat) =>
          `• ${shownText(chat.title, 120) || t('chatUntitled')} (${shownDate(chat.updatedAt, lang)})`,
      )
    const more = prompt.foreignChats.length - TRUST_CHATS_SHOWN
    if (more > 0) lines.push(t('trustMoreChats', { count: more }))
    parts.push(`— ${t('trustForeignChats')} —\n${lines.join('\n')}`)
  }
  return {
    type: 'question',
    title: t('trustTitle'),
    message: t('trustMessage', { name: prompt.name }),
    detail: parts.join('\n\n'),
    buttons: [t('trustUse'), t('trustWithout'), t('trustViewAll'), t('cancel')],
    defaultId: TRUST_CANCEL,
    cancelId: TRUST_CANCEL,
    noLink: true,
  }
}

/** The person's pick from the trust prompt's response; anything but the three choices cancels */
export function trustChoiceOf(response: number): ProjectTrustChoice {
  if (response === TRUST_USE) return 'use'
  if (response === TRUST_WITHOUT) return 'without'
  if (response === TRUST_VIEW) return 'view'
  return null
}

/** "'<file>' is not on this PC ...": [download] is response 0; cancel is the default */
export function downloadPromptOptions(lang: Lang, fileName: string): MessageBoxOptions {
  return {
    type: 'question',
    title: projectDialogText(lang, 'downloadTitle'),
    message: projectDialogText(lang, 'downloadMessage', { file: fileName }),
    buttons: [projectDialogText(lang, 'downloadButton'), projectDialogText(lang, 'cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

/** The last part of a folder path, either separator ("D:\docs\Budget" -> "Budget") */
function folderBaseName(folderPath: string): string {
  const parts = folderPath.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? folderPath
}

/**
 * "'<name>' already exists. Use that folder as the project?" for a new project
 * whose folder exists: [use this folder] is response 0
 */
export function useExistingPromptOptions(lang: Lang, folderPath: string): MessageBoxOptions {
  return {
    type: 'question',
    title: projectDialogText(lang, 'newProjectTitle'),
    message: projectDialogText(lang, 'useExistingMessage', { name: folderBaseName(folderPath) }),
    detail: folderPath,
    buttons: [projectDialogText(lang, 'useExistingButton'), projectDialogText(lang, 'cancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
}

export type ProjectFolderPickPurpose = 'add' | 'relocate' | 'parent'

/**
 * The folder picker for "add folder", relocating a missing project, and a new
 * project's parent folder ("create somewhere else…", spec 5.1)
 */
export function folderPickerOptions(
  lang: Lang,
  purpose: ProjectFolderPickPurpose,
): OpenDialogOptions {
  const title =
    purpose === 'add'
      ? 'pickFolderTitle'
      : purpose === 'relocate'
        ? 'relocateTitle'
        : 'pickParentTitle'
  return {
    title: projectDialogText(lang, title),
    buttonLabel: projectDialogText(lang, 'pickFolderButton'),
    properties: ['openDirectory', 'createDirectory'],
  }
}
