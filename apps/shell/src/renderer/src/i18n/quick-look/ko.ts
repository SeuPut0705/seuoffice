import type { zh } from './zh'

export const ko = {
  windowTitle: '빠른 미리보기',
  openInEditor: 'GenOffice에서 열기',
  revealInFolder: '폴더에서 보기',
  close: '닫기',
  prevFile: '이전 파일 (↑)',
  nextFile: '다음 파일 (↓)',
  shortcutHint: 'Space / Esc 닫기 · ↑↓ 파일 이동 · Enter 열기',
  loading: '미리보기를 불러오는 중…',
  empty: '미리볼 수 있는 본문 내용이 없습니다.',
  encrypted: '암호로 보호된 문서입니다. GenOffice에서 열어 잠금을 해제하세요.',
  unsupported: '이 파일 형식은 바로 미리볼 수 없습니다.',
  failed: '파일 미리보기를 읽지 못했습니다.',
  truncated: '문서 앞부분만 표시합니다. 전체 내용은 GenOffice에서 열어 확인하세요.',
  slideLabel: '슬라이드 {n}',
  sheetCount: '시트 {n}개',
  slideCount: '슬라이드 {n}장',
  lineCount: '{n}줄',
  charCount: '{n}자',
  tabThumbnail: '미리보기 그림',
  tabContent: '본문 내용',
  setQuickLookTitle: '빠른 미리보기 (스페이스바)',
  setQuickLookHint:
    'GenOffice 파일 목록에서 파일을 고른 뒤 스페이스바를 누르면 탭을 열지 않고 내용을 바로 미리 봅니다.',
  setExplorerSpace: 'Windows 파일 탐색기·바탕화면에서 스페이스바로 파일 미리보기',
  setExplorerSpaceDesc:
    '파일 탐색기나 바탕화면에서 파일을 선택하고 스페이스바를 누르면 미리보기 창을 띄웁니다.',
  setKeepInTray: '창을 닫아도 시스템 트레이에 남겨 탐색기 미리보기 유지',
  setKeepInTrayDesc:
    '메인 창을 닫은 뒤에도 백그라운드에서 대기하여 탐색기 스페이스바 미리보기가 즉시 작동합니다.',
  trayOpen: 'GenOffice 열기',
  trayQuit: 'GenOffice 종료',
} satisfies Record<keyof typeof zh, string>
