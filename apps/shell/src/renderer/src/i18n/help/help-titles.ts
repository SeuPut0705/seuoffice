/**
 * Per-language titles for the manual's sidebar and article headings.
 *
 * The registry holds the structure — which topics exist, their group and order
 * — and this holds the words, one entry per UI language. They are separate
 * because they change for different reasons and on different schedules: a new
 * topic lands in the registry, a new language lands here, and a language with
 * no body yet still needs a title so the sidebar never shows an empty row.
 */

import type { HelpGroupId } from './help-registry'

/** The languages the manual has titles for; `@seuoffice/i18n`'s list, minus none. */
export const HELP_TITLE_LANGS = ['en', 'ko'] as const

export type HelpTitleLang = (typeof HELP_TITLE_LANGS)[number]

/** Sidebar group headings, per language. */
const GROUP_TITLES: Record<HelpGroupId, Record<HelpTitleLang, string>> = {
  start: {
    en: 'Getting started',
    ko: '시작하기',
  },
  apps: {
    en: 'Applications',
    ko: '앱',
  },
  ai: {
    en: 'AI features',
    ko: 'AI 기능',
  },
  manage: {
    en: 'Files & settings',
    ko: '파일 및 설정',
  },
}

/** Article titles, per language, keyed by topic id. A language lands here when
 *  its bodies land in ./topics; until then the title falls back to English. */
const TOPIC_TITLES: Record<string, Record<HelpTitleLang, string>> = {
  'getting-started': {
    en: 'Quick start: the interface and the basics',
    ko: '빠른 시작: 인터페이스와 기본 조작',
  },
  'home-screen': {
    en: 'The Home screen: where your files live',
    ko: '홈 화면: 파일이 있는 곳',
  },
  'tabs-and-windows': {
    en: 'Tabs and window management',
    ko: '탭과 창 관리',
  },
  shortcuts: {
    en: 'Keyboard shortcuts',
    ko: '키보드 단축키',
  },
  docs: {
    en: 'Docs: word processing',
    ko: 'Docs: 문서 처리',
  },
  sheets: {
    en: 'Sheets: spreadsheets',
    ko: 'Sheets: 스프레드시트',
  },
  slides: {
    en: 'Slides: presentations',
    ko: 'Slides: 프레젠테이션',
  },
  pdf: {
    en: 'PDF: reading, annotating and redacting',
    ko: 'PDF: 읽기, 주석 달기, 가리개 처리',
  },
  // the PDF tools window's own title (i18n/pdf-tools/*.ts windowTitle)
  'pdf-tools': {
    en: 'PDF tools',
    ko: 'PDF 도구',
  },
  markdown: {
    en: 'The Markdown editor',
    ko: 'Markdown 편집기',
  },
  html: {
    en: 'The HTML editor',
    ko: 'HTML 편집기',
  },
  epub: {
    en: 'EPUB e-books: reading, editing and translating',
    ko: 'EPUB 전자책: 읽기, 고치기, 번역',
  },
  diagram: {
    en: 'Diagrams: drawing and editing draw.io files',
    ko: '다이어그램: draw.io 파일 그리기와 고치기',
  },
  'ai-panel': {
    en: 'The AI assistant panel',
    ko: 'AI 어시스턴트 패널',
  },
  'ai-models': {
    en: 'AI models and settings',
    ko: 'AI 모델과 설정',
  },
  // the same words as the section heading in Settings → AI (`setSubTitle`)
  skills: {
    en: 'Skills',
    ko: '스킬',
  },
  projects: {
    en: 'Projects',
    ko: '프로젝트',
  },
  'mcp-servers': {
    en: 'Connecting MCP servers',
    ko: 'MCP 서버 연결',
  },
  'agent-mode': {
    en: 'Agent mode',
    ko: '에이전트 모드',
  },
  subscription: {
    en: 'Subscription connection',
    ko: '구독 연결',
  },
  fonts: {
    en: 'Fonts: system fonts and installing font files',
    ko: '글꼴: 시스템 글꼴과 글꼴 파일 설치',
  },
  'file-ops': {
    en: 'File operations: rename, delete, export',
    ko: '파일 작업: 이름 바꾸기, 삭제, 내보내기',
  },
  'google-drive': {
    en: 'Google Drive',
    ko: 'Google 드라이브',
  },
  'settings-integrations': {
    en: 'Settings, language, theme and MCP integrations',
    ko: '설정, 언어, 테마와 MCP 연동',
  },
  install: {
    en: 'Installing SeuOffice',
    ko: 'SeuOffice 설치',
  },
  cli: {
    en: 'Command line and agents',
    ko: '명령줄과 에이전트',
  },
  mcp: {
    en: 'Connecting a coding agent',
    ko: '코딩 에이전트 연결',
  },
}

/** Sidebar group heading in the reader's language; English when unknown. */
export function groupTitle(id: HelpGroupId, lang: string): string {
  const row = GROUP_TITLES[id]
  return (row?.[lang as HelpTitleLang] ?? row?.en) as string
}

/** Article title in the reader's language; falls back to the topic id, which
 *  is never pretty, so a language added without its titles shows up as a gap
 *  rather than as a blank row. */
export function topicTitle(id: string, lang: string): string {
  const row = TOPIC_TITLES[id]
  // the table spells the product name as upstream does; show this product's
  return (row?.[lang as HelpTitleLang] ?? row?.en ?? id) as string
}
