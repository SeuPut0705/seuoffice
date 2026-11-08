import type { zh } from './zh'

export const ko = {
  actWebSearch: '웹 검색',
  actWebFetch: '웹 페이지 읽기',
  permWebSearch: '웹에서 검색',
  permWebFetch: '이 웹 페이지 읽기',
  permAllowSearchSession: '이번 세션 동안 검색 허락',
  permAllowSiteSession: '이번 세션 동안 이 사이트 허락',
  codexWebLabel: '웹 검색',
  codexWebCached: '저장된 결과',
  codexWebLive: '실시간',
  codexWebDisabled: '끄기',
  codexWebNote: '저장된 결과는 미리 모아 둔 웹 자료에서 찾고, 실시간은 지금의 웹을 검색합니다.',
  codexNetworkLabel: '명령의 인터넷 접속',
  codexNetworkOff: '끔',
  codexNetworkOn: '켬',
  codexNetworkWarning:
    "켜면 Codex가 실행하는 명령이 인터넷에 닿습니다. '이 프로젝트는 믿고 맡기기'에서는 묻지 않고 닿습니다. 받은 문서에 숨은 지시가 자료를 밖으로 보내게 할 수 있습니다.",
  codexFolderNote: '이 두 설정은 프로젝트 폴더마다 따로 기억합니다.',
  providerCodexNoteWeb:
    '명령은 Codex의 격리 공간에서 실행됩니다. 프로젝트 폴더에만 쓸 수 있고, 인터넷은 켜 두지 않으면 막힙니다.',
} satisfies Record<keyof typeof zh, string>
