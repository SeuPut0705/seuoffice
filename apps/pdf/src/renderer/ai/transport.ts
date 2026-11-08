import {
  createIpcTransport,
  type AgentTransport,
  type IpcContextGate,
  type IpcStreamError,
  type IpcSubscriptionUsage,
} from '@genoffice/agent-core'
import { localContextLimit } from '@genoffice/ai-provider/browser'
import type { AiSettings } from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import { aiContextConfirmText, aiRunErrorText } from '@genoffice/ui'
import { getLang, t } from '../i18n/locale'

/** What the AI panel learns from a turn besides its text (all optional) */
export interface ElectronTransportHooks {
  /** the UI language the run-error texts are worded in */
  lang(): Lang
  /** structured copy of a failure, delivered right before the loop's onError */
  onStreamError?(error: IpcStreamError): void
  /** rate-limit windows a subscription CLI reported during the turn */
  onSubscriptionUsage?(usage: IpcSubscriptionUsage[]): void
  /** the input was cut to fit a limit; the user must be told */
  onInputTruncated?(): void
  /**
   * 'request': cancelling ends this stream only, not the tab's image and
   * media calls (a document job's call; the AI window's Stop ends both)
   */
  cancelScope?: 'request'
  /**
   * One document job's confirmation memory: every call of the job shares it,
   * so a large prompt is confirmed once for the whole job.
   */
  contextGate?: IpcContextGate
}

/** The shared IPC transport wired to the pdf preload bridge (window.pdfApi). */
export function createElectronTransport(
  getSettings: () => AiSettings,
  hooks?: ElectronTransportHooks,
): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.pdfApi.onAiStream(listener),
    start: (request) => window.pdfApi.aiStream(request),
    cancel: (requestId) =>
      void (hooks?.cancelScope
        ? window.pdfApi.aiStreamCancel(requestId, hooks.cancelScope)
        : window.pdfApi.aiStreamCancel(requestId)),
    getSettings,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
    networkErrorText: () => t('aiNetworkError'),
    overloadedErrorText: () => t('aiOverloadedError'),
    // a local model's window: the transport warns at 80% and asks once per run
    contextLimit: (settings) => localContextLimit(settings),
    confirmContext: (warning) =>
      window.confirm(aiContextConfirmText(hooks?.lang() ?? getLang(), warning)),
    // the subscription causes are worded once for every editor; the kinds above keep pdf's texts
    ...(hooks
      ? {
          errorText: (cause) => aiRunErrorText(hooks.lang(), cause),
          onStreamError: (error) => hooks.onStreamError?.(error),
          onSubscriptionUsage: (usage) => hooks.onSubscriptionUsage?.(usage),
          onInputTruncated: () => hooks.onInputTruncated?.(),
          ...(hooks.contextGate ? { contextGate: hooks.contextGate } : {}),
        }
      : {}),
  })
}
