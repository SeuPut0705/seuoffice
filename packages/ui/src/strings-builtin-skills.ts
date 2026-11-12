import { createI18n, defineStrings, type Lang } from '@seuoffice/i18n'

/**
 * Names of the skills shipped with the app (apps/shell/resources/builtin-skills).
 * Must match the "name" entries of builtin-skills.json there.
 */
export const BUILTIN_SKILL_NAMES = [
  'meeting-minutes',
  'internal-comms',
  'humanizer',
  'copy-editing',
  'find-skills',
  'administration-report',
  'administration-report-draft',
  'docx',
  'pptx',
  'xlsx',
  'pdf',
  'hwp-document',
  'mindmap',
  'diagram',
  'html-document',
] as const

export type BuiltinSkillName = (typeof BUILTIN_SKILL_NAMES)[number]

const en = {
  'builtinSkillDesc.meeting-minutes':
    'Turns meeting notes into minutes that show the decisions and action items.',
  'builtinSkillDesc.internal-comms':
    'Writes announcements, newsletters, progress updates, FAQs and other internal messages.',
  'builtinSkillDesc.humanizer':
    'Finds phrasing that sounds AI-written and makes it natural without changing what it says.',
  'builtinSkillDesc.copy-editing':
    'Goes over English text you have already written and makes it clearer and tighter.',
  'builtinSkillDesc.find-skills':
    'Works only in the agent window and needs internet access to find skills and suggest installing them.',
  'builtinSkillDesc.administration-report':
    'Brings a report in line with the Ministry of the Interior and Safety guideline: prose, standard numbering, fonts that open anywhere, simple tables.',
  'builtinSkillDesc.administration-report-draft':
    'Writes an administrative report from scratch in the ministry format: sections, the Ⅰ·1·가 numbering, prose, table titles and compatible fonts.',
  'builtinSkillDesc.docx':
    'Works only in the agent window. Runs scripts to create, edit and read .docx files in the project folder. Python and other programs must be installed on this PC.',
  'builtinSkillDesc.pptx':
    'Works only in the agent window. Runs scripts to create, edit and read .pptx files in the project folder. Python and other programs must be installed on this PC.',
  'builtinSkillDesc.xlsx':
    'Works only in the agent window. Runs scripts to create and edit .xlsx files in the project folder and recalculate their formulas. Python and other programs must be installed on this PC.',
  'builtinSkillDesc.pdf':
    'Works only in the agent window. Runs scripts to read, merge and split .pdf files in the project folder and fill in forms. Python and other programs must be installed on this PC.',
  'builtinSkillDesc.hwp-document':
    'Writes a new .hwp or .hwpx document from scratch: picks the parts for a report, plan, notice, official letter or minutes, writes it in document style, and checks it at the end.',
  'builtinSkillDesc.mindmap':
    'Builds a mind map from a topic or material: three to seven balanced main branches, short titles with the detail in notes, and a structure check at the end.',
  'builtinSkillDesc.diagram':
    'Draws a clear diagram: picks the type that fits, keeps one direction, short labels and few colours, and checks for overlaps and loose shapes.',
  'builtinSkillDesc.html-document':
    'Makes an HTML document that reads well on screen and prints cleanly: settles the reader, length and paper first, then checks the pages and the content.',
}

/**
 * One-line description of each built-in skill, shared by the shell (Settings →
 * Skills) and the editors' AI panel skill list; lists show the skill's name
 * itself. Keys are `builtinSkillDesc.<name>`; `en` defines the key set.
 */
export const BUILTIN_SKILL_STRINGS = defineStrings({
  en,
  ko: {
    'builtinSkillDesc.meeting-minutes':
      '회의 메모를 결정 사항과 할 일이 보이는 회의록으로 정리합니다.',
    'builtinSkillDesc.internal-comms':
      '공지, 소식지, 진행 보고, 자주 묻는 질문 같은 조직 안의 글을 씁니다.',
    'builtinSkillDesc.humanizer':
      '글에서 AI가 쓴 티가 나는 표현을 찾아 내용은 그대로 두고 자연스럽게 고칩니다.',
    'builtinSkillDesc.copy-editing':
      '이미 쓴 영어 글을 여러 번 훑으며 더 분명하고 간결하게 다듬습니다.',
    'builtinSkillDesc.find-skills':
      '에이전트 창에서만 쓸 수 있으며, 인터넷에 연결해 필요한 스킬을 찾고 설치를 제안합니다.',
    'builtinSkillDesc.administration-report':
      '행안부 가이드라인에 맞게 보고서를 다듬습니다. 서술식 문장, 표준 번호, 호환 글꼴, 단순한 표.',
    'builtinSkillDesc.administration-report-draft':
      '행안부 형식으로 행정문서를 처음부터 씁니다. 절 구성, Ⅰ·1·가 번호, 서술식 문장, 표 제목과 호환 글꼴.',
    'builtinSkillDesc.docx':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .docx 파일을 만들고 고치고 읽습니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.pptx':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .pptx 파일을 만들고 고치고 읽습니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.xlsx':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .xlsx 파일을 만들고 고치고 수식을 다시 계산합니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.pdf':
      '에이전트 창에서만 쓸 수 있습니다. 스크립트를 실행해 프로젝트 폴더의 .pdf 파일을 읽고 합치고 나누고 양식을 채웁니다. 이 PC에 Python 같은 프로그램이 설치되어 있어야 합니다.',
    'builtinSkillDesc.hwp-document':
      '한글 문서(.hwp, .hwpx)를 처음부터 씁니다. 보고서·계획서·안내문·공문·회의록에 맞는 짜임을 고르고, 문서 문체로 쓴 뒤 마지막에 점검합니다.',
    'builtinSkillDesc.mindmap':
      '주제나 자료로 마인드맵을 만듭니다. 큰 가지 3~7개를 고르게 잡고, 제목은 짧게 쓰고 설명은 메모에 두며, 마지막에 짜임을 점검합니다.',
    'builtinSkillDesc.diagram':
      '읽기 쉬운 다이어그램을 그립니다. 알맞은 종류를 고르고, 흐름은 한 방향으로, 글은 짧게, 색은 적게 쓰며, 겹침과 떨어진 도형을 점검합니다.',
    'builtinSkillDesc.html-document':
      '화면에서 읽기 좋고 인쇄해도 깔끔한 HTML 문서를 만듭니다. 읽는 사람·분량·용지를 먼저 정하고, 쪽 나눔과 내용을 점검합니다.',
  },
})

export type BuiltinSkillStringKey = keyof typeof en

/** `builtinSkillText(lang, key)`: one built-in skill string in that language */
export const builtinSkillText: (lang: Lang, key: BuiltinSkillStringKey) => string =
  createI18n(BUILTIN_SKILL_STRINGS)

/** One-line description of a built-in skill in `lang` (key `builtinSkillDesc.<name>`) */
export function builtinSkillDesc(lang: Lang, name: BuiltinSkillName): string {
  return builtinSkillText(lang, `builtinSkillDesc.${name}`)
}

/** Narrows a skill name read from disk or settings to a built-in skill name */
export function isBuiltinSkillName(name: string): name is BuiltinSkillName {
  return (BUILTIN_SKILL_NAMES as readonly string[]).includes(name)
}
