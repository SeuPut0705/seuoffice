import {
  createIpcTransport,
  type AgentTransport,
  type IpcStreamError,
  type IpcSubscriptionUsage,
} from '@genoffice/agent-core'
import type { AiSettings } from '@genoffice/ai-provider'
import type { Lang } from '@genoffice/i18n'
import { localContextLimit } from '@genoffice/ai-provider/browser'
import { aiContextConfirmText, aiRunErrorText } from '@genoffice/ui'
import { t } from '../i18n/locale'

/** What the panel learns from a turn besides its text: the cause of a failure, subscription usage, a cut input */
export interface ElectronTransportHooks {
  /** current UI language, for the shared run-error texts */
  lang(): Lang
  onStreamError?(error: IpcStreamError): void
  onSubscriptionUsage?(usage: IpcSubscriptionUsage[]): void
  onInputTruncated?(): void
}

/** The shared IPC transport wired to the hwp preload bridge (window.hwpApi). */
export function createElectronTransport(
  getSettings: () => AiSettings,
  hooks: ElectronTransportHooks,
): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.hwpApi.onAiStream(listener),
    start: (request) => window.hwpApi.aiStream(request),
    cancel: (requestId) => void window.hwpApi.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
    networkErrorText: () => t('aiNetworkError'),
    overloadedErrorText: () => t('aiOverloadedError'),
    // one wording for the subscription causes across editors; undefined keeps the texts above
    errorText: (cause) => aiRunErrorText(hooks.lang(), cause),
    // a local model's window: the transport warns at 80% and asks once per run
    contextLimit: (settings) => localContextLimit(settings),
    confirmContext: (warning) => window.confirm(aiContextConfirmText(hooks.lang(), warning)),
    onStreamError: (error) => hooks.onStreamError?.(error),
    onSubscriptionUsage: (usage) => hooks.onSubscriptionUsage?.(usage),
    onInputTruncated: () => hooks.onInputTruncated?.(),
  })
}
