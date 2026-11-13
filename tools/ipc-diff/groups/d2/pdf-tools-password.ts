/**
 * Group `d2/pdf-tools-password`: the password prompt for encrypted PDFs
 * (`apps/shell/src/main/pdf-password-dialog.ts`). Its channels exist once the
 * shell asked for a password (`promptPdfPassword`, the
 * `d2/pdf-tools:prompt-password` trigger); the prompt window is the case's
 * `ShellPdfPassword` view 901. What each prompt settles with goes to the log
 * (`promptPdfPassword.settled`).
 */
import type { Case, Group, View } from '../../types.ts'
import { loadPdfTools, trigger, triggers } from './pdf-tools-fakes/load.ts'

const SHELL: View = { view: 1, window: 1, surface: 'Shell' }
const PROMPT: View = { view: 901, window: 901, surface: 'ShellPdfPassword' }
const views = [SHELL, PROMPT]

/** a `PdfPasswordUiState` as the shell's export flows build it */
const state = (retry: boolean) => ({
  fileName: 'secret.pdf',
  retry,
  busy: true,
  lang: 'ko',
  strings: {
    title: 'PDF password',
    prompt: 'Enter the password',
    retryPrompt: 'Wrong password',
    ok: 'OK',
    cancel: 'Cancel',
    verifying: 'Checking',
    label: 'Password',
    placeholder: '',
    show: 'Show',
    hide: 'Hide',
  },
})
const call = (channel: string, ...args: unknown[]) => ({ channel, view: 901, args })
const prompt = (retry = false) => trigger('prompt-password', 1, [state(retry)])

const cases: Case[] = [
  {
    note: 'one prompt is one attempt; a rejected password re-prompts in the open window',
    views,
    calls: [
      prompt(),
      call('pdf-password:get-state'),
      call('pdf-password:submit', 5),
      call('pdf-password:submit', 'wrong'),
      call('pdf-password:get-state'),
      prompt(true),
      call('pdf-password:get-state'),
      call('pdf-password:cancel'),
      call('pdf-password:get-state'),
      call('pdf-password:submit', 'late'),
    ],
  },
  {
    note: 'the export ends: the dialog closes; a new prompt answers a pending one as cancelled',
    views,
    calls: [
      prompt(),
      trigger('close-password-dialog', 1),
      call('pdf-password:get-state'),
      prompt(),
      prompt(true),
      call('pdf-password:submit', 'pw'),
    ],
  },
  {
    note: 'the shell window may not answer for the prompt',
    views,
    calls: [prompt(), { channel: 'pdf-password:submit', view: 1, args: ['pw'] }],
  },
]

export const group: Group & { triggers: typeof triggers } = {
  batch: 'D2',
  load: loadPdfTools,
  cases,
  single: {
    'pdf-password:cancel':
      'takes no arguments; its effects are the settled prompt and the closed window',
  },
  triggers,
}
