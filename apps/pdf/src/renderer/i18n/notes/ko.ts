import type { zh } from './zh'

export const ko = {
  ntOpen: '노트 열기',
  ntOpenTip: '이 PDF와 이어진 마크다운 노트를 엽니다',
  ntInsert: '노트에 넣기',
  ntInsertTip: '이 내용을 노트 끝에 넣습니다. 저장은 노트 탭에서 합니다',
  ntSaveFirst: 'PDF를 먼저 저장하세요',
  ntUnavailable: '노트는 GenOffice 앱 안에서만 열 수 있습니다',
  ntFailed: '노트를 열지 못했습니다. {reason}',
  ntInserted: '노트에 넣었습니다',
} satisfies Record<keyof typeof zh, string>
