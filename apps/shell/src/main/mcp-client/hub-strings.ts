import { createI18n, defineStrings, type Lang } from '@seuoffice/i18n'
import type { LoopbackPages } from './oauth-loopback'

/**
 * Text the main process shows people about their MCP servers: the page the
 * browser shows after a server's sign-in, and why a "my PC" server could not
 * start (the reason view of a failed server). What the AI reads is English
 * and lives with the hub. `en` defines the key set.
 */
const en = {
  pageDoneTitle: 'Signed in',
  pageDoneBody: 'You can close this tab and go back to SeuOffice.',
  pageFailedTitle: 'Sign-in did not finish',
  pageFailedBody: 'Go back to SeuOffice and try again.',
  problemNeedsCommandWindow: 'This command can’t run without a command window.',
  problemEmptyCommand: 'Enter the command to run.',
  problemNotAProgram: 'This file can’t be run as a program.',
  problemRuntimeMissing: 'The program this server needs isn’t on this PC.',
  problemDidNotStart: 'The server didn’t start.',
}

type Keys = Record<keyof typeof en, string>

export const MCP_HUB_STRINGS = defineStrings({
  en,
  ko: {
    pageDoneTitle: '로그인했습니다',
    pageDoneBody: '이 탭을 닫고 SeuOffice로 돌아가세요.',
    pageFailedTitle: '로그인을 마치지 못했습니다',
    pageFailedBody: 'SeuOffice로 돌아가 다시 시도하세요.',
    problemNeedsCommandWindow: '이 명령은 명령 창 없이 실행할 수 없습니다.',
    problemEmptyCommand: '실행할 명령을 넣으세요.',
    problemNotAProgram: '이 파일은 프로그램으로 실행할 수 없습니다.',
    problemRuntimeMissing: '이 서버에 필요한 프로그램이 이 PC에 없습니다.',
    problemDidNotStart: '서버가 시작되지 않았습니다.',
  } satisfies Keys,
})

export type McpHubStringKey = keyof typeof en

export const mcpHubText = createI18n(MCP_HUB_STRINGS)

/** The pages the browser shows after a server's sign-in, in the person's language */
export function mcpSignInPages(lang: Lang): LoopbackPages {
  return {
    done: {
      lang,
      title: mcpHubText(lang, 'pageDoneTitle'),
      body: mcpHubText(lang, 'pageDoneBody'),
    },
    failed: {
      lang,
      title: mcpHubText(lang, 'pageFailedTitle'),
      body: mcpHubText(lang, 'pageFailedBody'),
    },
  }
}

/** Why a "my PC" server could not start, as the reason view says it */
export type McpLaunchProblemKey =
  'needs-command-window' | 'empty-command' | 'not-a-program' | 'runtime-missing' | 'did-not-start'

const PROBLEM_KEYS: Record<McpLaunchProblemKey, McpHubStringKey> = {
  'needs-command-window': 'problemNeedsCommandWindow',
  'empty-command': 'problemEmptyCommand',
  'not-a-program': 'problemNotAProgram',
  'runtime-missing': 'problemRuntimeMissing',
  'did-not-start': 'problemDidNotStart',
}

export function mcpLaunchProblemText(lang: Lang, problem: McpLaunchProblemKey): string {
  return mcpHubText(lang, PROBLEM_KEYS[problem])
}
