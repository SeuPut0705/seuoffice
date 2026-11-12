import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'

/**
 * The agent window's start screen: a project folder's own skills and the
 * person's choice for them (decision 0064). Kept apart from the window's other
 * strings; `en` defines the key set.
 */
const en = {
  label: 'Skills in this folder',
  note: 'This folder has {count} skills of its own. Turned on, the agent reads and follows them without asking. If someone else gave you this folder, look at them first.',
  on: 'Turn on',
  off: 'Leave off',
  changed:
    'These skills changed after you turned them on, so they stay off until you choose again.',
  remember: 'Your choice is kept for this folder. If the skills change, you are asked again.',
}

type Keys = Record<keyof typeof en, string>

export const agentProjectSkillsStrings = defineStrings({
  en,
  ko: {
    label: '이 폴더의 스킬',
    note: '이 폴더에는 자체 스킬이 {count}개 있습니다. 켜면 에이전트가 묻지 않고 이 스킬을 읽고 따릅니다. 남에게 받은 폴더라면 먼저 내용을 확인하세요.',
    on: '켜기',
    off: '켜지 않기',
    changed: '켠 뒤로 스킬이 바뀌어서, 다시 고를 때까지 꺼 둡니다.',
    remember: '고른 값은 이 폴더에 기억됩니다. 스킬이 바뀌면 다시 묻습니다.',
  } satisfies Keys,
})

export type AgentProjectSkillsStringKey = keyof typeof en

const translate = createI18n(agentProjectSkillsStrings)

export function agentProjectSkillsText(
  lang: Lang,
  key: AgentProjectSkillsStringKey,
  params?: Params,
): string {
  return translate(lang, key, params)
}
