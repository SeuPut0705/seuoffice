import { createI18n, defineStrings, type Lang } from '@genoffice/i18n'

/**
 * The person's own MCP servers in an AI window: the permission card before
 * an `ask` tool runs (user MCP spec 7.4) and the server button beside the
 * input (spec 7.5) with the status words of spec 12.2.
 */
const en = {
  cardTitle: 'The AI wants to use the {tool} tool of {server}',
  inputLabel: 'What will be sent',
  noInput: 'Nothing to send',
  more: 'Show more',
  allowOnce: 'Allow this once',
  allowConversation: 'Always allow in this conversation',
  deny: 'Block',
  buttonLabel: 'Connected servers',
  listHint: 'Turning a server off here affects only this conversation',
  useInChat: 'Use {server} in this conversation',
  statusConnected: 'Connected',
  statusConnecting: 'Connecting',
  statusFailed: 'Could not connect',
  statusLoginRequired: 'Needs a new sign-in',
  statusReviewRequired: 'Needs review',
  statusDisabled: 'Off',
  reasonUnreachable: 'Could not reach the server',
  reasonRuntimeMissing: 'What it needs to run is missing',
  reasonStartFailed: 'Could not start',
  reasonRefusedRedirect: 'Blocked: it tried to send you to another address',
  reasonInsecureAddress: 'The address is not safe',
  newTools: 'New tools: {n}',
  relogin: 'Sign in again',
  review: 'Go review',
  retry: 'Try again',
  statusReady: 'Ready',
  statusUnchecked: 'Not checked yet',
  reasonHttpError: 'The server answered with an error',
  checkInSettings: 'Check the connection in Settings',
  enableInSettings: 'Turn on in Settings',
  offInChat: 'Off in this conversation',
  destructive: 'May delete or change things',
  toolAbout: 'About this tool',
  blockedStep: '{server} · {tool}: blocked',
}

export const USER_MCP_STRINGS = defineStrings({
  en,
  ko: {
    cardTitle: 'AI가 {server}의 {tool} 도구를 쓰려고 합니다',
    inputLabel: '보낼 내용',
    noInput: '보낼 내용이 없습니다',
    more: '더 보기',
    allowOnce: '이번만 허용',
    allowConversation: '이 대화에서 항상 허용',
    deny: '막기',
    buttonLabel: '연결한 서버',
    listHint: '여기서 끄면 이 대화에서만 꺼집니다',
    useInChat: '이 대화에서 {server} 쓰기',
    statusConnected: '연결됨',
    statusConnecting: '연결 중',
    statusFailed: '연결 못 함',
    statusLoginRequired: '다시 로그인 필요',
    statusReviewRequired: '확인 필요',
    statusDisabled: '꺼짐',
    reasonUnreachable: '서버에 닿지 못함',
    reasonRuntimeMissing: '실행 환경 없음',
    reasonStartFailed: '시작 실패',
    reasonRefusedRedirect: '다른 주소로 넘기려 해 막음',
    reasonInsecureAddress: '안전하지 않은 주소',
    newTools: '새 도구 {n}개',
    relogin: '다시 로그인',
    review: '확인하러 가기',
    retry: '다시 시도',
    statusReady: '준비됨',
    statusUnchecked: '확인 전',
    reasonHttpError: '서버가 오류로 답함',
    checkInSettings: '설정에서 연결 확인',
    enableInSettings: '설정에서 켜기',
    offInChat: '이 대화에서 끔',
    destructive: '지우거나 바꿀 수 있음',
    toolAbout: '도구 설명',
    blockedStep: '{server} · {tool}: 막음',
  },
})

export type UserMcpStringKey = keyof typeof en

/** `userMcpText(lang, key, params?)`: one user-MCP string in that language */
export const userMcpText: (
  lang: Lang,
  key: UserMcpStringKey,
  params?: Record<string, string | number>,
) => string = createI18n(USER_MCP_STRINGS)
