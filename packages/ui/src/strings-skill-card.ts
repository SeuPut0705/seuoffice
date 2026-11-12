import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'

/**
 * The skill card an AI panel shows when the model proposes a skill (spec 5.6)
 * and the tool rows of the skill tools (spec 5.5).
 */
const en = {
  cardNewTitle: 'New skill',
  cardEditTitle: 'Change skill',
  fieldTitle: 'Title',
  titleHint: 'Shown in lists, in any language. Leave it empty to show the name',
  fieldDescription: 'Description',
  fieldBody: 'Instructions',
  fieldName: 'Name',
  nameHint:
    'Shown in the skill list. Lowercase English letters, digits and hyphens (-), up to 64 characters',
  invokeLabel: 'When the AI uses it',
  invokeAuto: 'On its own',
  invokeManual: 'Only when called',
  templateCheck: 'Save this document along as a template',
  templateBlank: 'Make a blank template',
  templateAsIs: 'Save the document as it is',
  save: 'Save',
  replace: 'Replace',
  cancel: 'Cancel',
  saving: 'Saving…',
  copyNotice: 'A copy is saved to my skills, and the original skill is turned off',
  saved: 'Saved',
  openSettings: 'View in Settings',
  unsaved: 'Unsaved skill proposal',
  blockDescription: 'Enter a description',
  blockBody: 'Enter the instructions',
  nameChecking: 'Checking the name…',
  nameEmpty: 'Enter a name',
  nameTooLong: 'The name can be up to 64 characters',
  nameCharacters:
    'The name can use only lowercase English letters, digits and hyphens (-). A title in your own language goes in the Title field above',
  nameHyphenEdge: 'The name cannot start or end with a hyphen (-)',
  nameDoubleHyphen: 'The name cannot have two hyphens in a row (--)',
  nameReserved: 'This name cannot be used',
  nameTaken: 'My skills already have a skill with this name',
  nameTakenReplace: 'My skills already have a skill with this name; saving replaces it',
  sameNameOn:
    'A skill of the same name is on ({sources}). If you save, your skill is used instead and that one is turned off.',
  saveTurnOff: 'Save and turn that one off',
  saveFailed: 'Could not save',
  trashFailed: 'The skill it replaces could not be moved to the trash, so nothing was saved',
  noBridge: 'Skills cannot be saved in this window',
  skillUsed: 'Used the {title} skill',
  skillProposed: 'Skill proposal: {title}',
}

export const SKILL_CARD_STRINGS = defineStrings({
  en,
  ko: {
    cardNewTitle: '스킬 만들기',
    cardEditTitle: '스킬 고치기',
    fieldTitle: '제목',
    titleHint: '목록에 보이는 제목입니다. 어떤 언어로든 적을 수 있고, 비워 두면 이름이 보입니다',
    fieldDescription: '설명',
    fieldBody: '본문',
    fieldName: '이름',
    nameHint: '스킬 목록에 보이는 이름입니다. 영어 소문자·숫자·하이픈(-)으로 64자까지',
    invokeLabel: 'AI가 쓰는 때',
    invokeAuto: '스스로 쓰기',
    invokeManual: '부를 때만',
    templateCheck: '이 문서를 양식으로 함께 저장',
    templateBlank: '비운 양식 만들기',
    templateAsIs: '원래 문서 그대로 저장',
    save: '저장',
    replace: '바꾸기',
    cancel: '취소',
    saving: '저장하는 중…',
    copyNotice: '내 스킬로 사본을 만들어 저장하고, 원래 스킬은 끕니다',
    saved: '저장했습니다',
    openSettings: '설정에서 보기',
    unsaved: '저장하지 않은 스킬 제안',
    blockDescription: '설명을 적어 주세요',
    blockBody: '본문을 적어 주세요',
    nameChecking: '이름을 확인하는 중…',
    nameEmpty: '이름을 적어 주세요',
    nameTooLong: '이름은 64자까지입니다',
    nameCharacters:
      '이름에는 영어 소문자, 숫자, 하이픈(-)만 쓸 수 있습니다. 한글 제목은 위 제목 칸에 적으세요',
    nameHyphenEdge: '이름은 하이픈(-)으로 시작하거나 끝날 수 없습니다',
    nameDoubleHyphen: '이름에 하이픈을 두 번(--) 잇달아 쓸 수 없습니다',
    nameReserved: '이 이름은 쓸 수 없습니다',
    nameTaken: '내 스킬에 같은 이름이 있습니다',
    nameTakenReplace: '내 스킬에 같은 이름이 있어, 저장하면 그 스킬을 바꿉니다',
    sameNameOn:
      '같은 이름의 스킬이 켜져 있습니다({sources}). 저장하면 내 스킬이 대신 쓰이고 그 스킬은 꺼집니다.',
    saveTurnOff: '저장하고 그 스킬 끄기',
    saveFailed: '저장하지 못했습니다',
    trashFailed: '바꿀 스킬을 휴지통으로 옮기지 못해 아무것도 저장하지 않았습니다',
    noBridge: '이 창에서는 스킬을 저장할 수 없습니다',
    skillUsed: '{title} 스킬을 썼습니다',
    skillProposed: '스킬 제안: {title}',
  },
})

export type SkillCardStringKey = keyof typeof en

/** `skillCardText(lang, key, params?)`: one skill-card string in that language */
export const skillCardText: (
  lang: Lang,
  key: SkillCardStringKey,
  params?: Record<string, string | number>,
) => string = createI18n(SKILL_CARD_STRINGS)
