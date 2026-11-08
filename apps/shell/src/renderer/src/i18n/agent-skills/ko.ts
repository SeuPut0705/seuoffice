import type { zh } from './zh'

export const ko = {
  noticeText:
    '스킬은 이제 설정 → 스킬에서 켜고 끕니다. Claude·Codex 스킬 폴더의 스킬은 꺼진 채로 시작합니다.',
  noticeOpenSettings: '설정 열기',
  noticeClose: '닫기',
  nextSession: '바뀐 스킬은 다음 세션부터 적용됩니다',
  templateLabel: '양식으로 함께 저장할 문서',
  templateNone: '양식 없음',
  templateFromTab: '탭에 열림',
  templateFromProject: '프로젝트 폴더',
  templateUnsaved: '이 탭에는 저장하지 않은 고친 내용이 있습니다. 저장된 파일이 양식이 됩니다.',
  templateChecking: '가린 내용이 있는지 확인하는 중…',
  templateUnknown:
    '이 형식은 가린 내용이 있는지 여기서 확인할 수 없어 원래 문서 그대로 저장할 수 없습니다. 비운 양식을 만들어 저장하세요.',
  templateTooLarge: '이 문서는 너무 커서 양식으로 저장할 수 없습니다',
  installTitle: 'AI가 이 스킬 설치를 제안합니다',
  installHint:
    '미리보기에서 내용을 확인한 뒤 설치할지 정하세요. 설치한 스킬은 다음 세션부터 쓰입니다.',
  installOpen: '미리보기 열기',
  installDismiss: '닫기',
  installDismissed: '설치하지 않음',
  installCancel: '취소',
  actProposeSkill: '스킬 제안',
} satisfies Record<keyof typeof zh, string>
