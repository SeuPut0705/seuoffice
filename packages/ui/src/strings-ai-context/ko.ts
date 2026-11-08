import type { zh } from './zh'

export const ko = {
  contextConfirm:
    '이번 요청은 모델의 문맥 한도에 가깝습니다. 약 {estimated}/{limit} 토큰({percent}%)입니다. 그래도 보낼까요?',
  contextUnknown: '문맥을 확인하지 못했습니다. {limit} 토큰으로 가정합니다.',
  toolsUnsupported:
    '이 모델은 도구 호출을 지원하지 않습니다. 글자로만 제안하고 문서는 고치지 않습니다.',
  errContextLimit:
    '보내지 않았습니다. 요청이 모델의 문맥 한도에 가깝습니다. 요청을 나누어 다시 보내세요.',
} satisfies Record<keyof typeof zh, string>
