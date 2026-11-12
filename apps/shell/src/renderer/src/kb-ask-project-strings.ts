import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'

/**
 * The home ask panel's own wording for project folders (decision 0088). The
 * picker, the chat menu and the notice lines bring theirs from @seuoffice/ui;
 * this is what the home ask says about the chosen project: its head, input
 * hint and first line, a document saved into its folder, and why a question
 * could not use it. `en` defines the key set.
 */
const en = {
  askProjectMissing:
    'The chosen project’s folder could not be found, so nothing was sent. Choose the project again below.',
  askProjectTitle: 'Ask the project “{name}”',
  askProjectPlaceholder: 'Ask about the files in the project “{name}”…',
  askProjectStarsPlaceholder: 'Ask about the files in the project “{name}” and your starred files…',
  askProjectIntro:
    'Answers come from the files in the “{name}” project folder, found and read as needed.',
  askHeroProjectHint: 'Or choose a project below.',
  askSavedToProject: 'Saved in the project folder: {name}',
  askOpenCreated: 'Open',
}

export const kbAskProjectStrings = defineStrings({
  en,
  ko: {
    askProjectMissing:
      '고른 프로젝트의 폴더를 찾을 수 없어 보내지 않았습니다. 아래에서 프로젝트를 다시 고르세요.',
    askProjectTitle: '프로젝트 ‘{name}’에 질문',
    askProjectPlaceholder: '‘{name}’ 프로젝트의 파일에 대해 질문…',
    askProjectStarsPlaceholder: '‘{name}’ 프로젝트의 파일과 즐겨찾기한 파일에 대해 질문…',
    askProjectIntro: '‘{name}’ 프로젝트 폴더의 파일을 찾아 읽고 답합니다.',
    askHeroProjectHint: '또는 아래에서 프로젝트를 고르세요.',
    askSavedToProject: '프로젝트 폴더에 저장함: {name}',
    askOpenCreated: '열기',
  },
})

export type KbAskProjectStringKey = keyof typeof en

const translate = createI18n(kbAskProjectStrings)

export function kbAskProjectText(lang: Lang, key: KbAskProjectStringKey, params?: Params): string {
  return translate(lang, key, params)
}
