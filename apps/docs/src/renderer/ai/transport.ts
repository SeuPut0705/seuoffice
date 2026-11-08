import {
  createIpcTransport,
  type AgentTransport,
  type IpcTransportOptions,
} from '@genoffice/agent-core'
import { localContextLimit } from '@genoffice/ai-provider/browser'
import { aiContextConfirmText, aiRunErrorText } from '@genoffice/ui'
import type { AiSettings } from '../../shared/ipc'
import { getLang, t } from '../i18n/locale'

/** what the panel wants to hear from a turn besides its text: the failure cause, usage, a cut input */
export type ElectronTransportHooks = Pick<
  IpcTransportOptions<AiSettings>,
  'onStreamError' | 'onSubscriptionUsage' | 'onInputTruncated'
>

/** The shared IPC transport wired to the docs preload bridge (window.desktop). */
export function createElectronTransport(
  getSettings: () => AiSettings,
  hooks: ElectronTransportHooks = {},
): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.desktop.onAiStream(listener),
    start: (request) => window.desktop.aiStream(request),
    cancel: (requestId) => void window.desktop.aiStreamCancel(requestId),
    getSettings,
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    networkErrorText: () => t('aiNetworkError'),
    overloadedErrorText: () => t('aiOverloadedError'),
    // the subscription causes are worded once for every editor
    errorText: (cause) => aiRunErrorText(getLang(), cause),
    // a local model's window: the transport warns at 80% and asks once per run
    contextLimit: (settings) => localContextLimit(settings),
    confirmContext: (warning) => window.confirm(aiContextConfirmText(getLang(), warning)),
    ...hooks,
  })
}
