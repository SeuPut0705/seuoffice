// Contract between the slides renderer (AI panel) and the main process for the
// subscription providers (Claude, Codex). The channels and payloads are the
// shared ones from @genoffice/ai-provider; the handlers are registered once per
// process (by the shell's AI registration, or by slides itself when standalone).

import type {
  AiSubscriptionProviderId,
  SubscriptionLaunchResult,
  SubscriptionLoginMode,
  SubscriptionMeteredResult,
  SubscriptionStatusMap,
} from '@genoffice/ai-provider/browser'

// Reading an IPC answer is the same in every app: one implementation, in the shared contract
export {
  checkingSubscriptionStatuses,
  subscriptionLaunchResultOf,
  subscriptionStatusMapOf,
} from '@genoffice/ai-provider/browser'

/** exposed as `window.slidesApi.aiSubscription` by the slides preload */
export interface SubscriptionApi {
  /** the last known connection statuses (`checking` until a first check answered) */
  statuses(): Promise<SubscriptionStatusMap>
  /** look again (both providers when none is named) and answer when done */
  recheck(providers?: AiSubscriptionProviderId[]): Promise<SubscriptionStatusMap>
  /** open the program's own sign-in; `window` asks for its window, where a code is pasted */
  login(
    provider: AiSubscriptionProviderId,
    mode?: SubscriptionLoginMode,
  ): Promise<SubscriptionLaunchResult>
  /** run the vendor's official install command in a visible terminal window */
  install(provider: AiSubscriptionProviderId): Promise<SubscriptionLaunchResult>
  /** run the official update of a program below the app's floor, in a terminal window */
  update(provider: AiSubscriptionProviderId): Promise<SubscriptionLaunchResult>
  /** end a sign-in the app started (nothing under way is not a failure) */
  cancelLogin(provider: AiSubscriptionProviderId): Promise<SubscriptionLaunchResult>
  /** "use anyway" for a metered login (or take that back) */
  setMeteredAccepted(
    provider: AiSubscriptionProviderId,
    accepted: boolean,
  ): Promise<SubscriptionMeteredResult>
  /** the statuses changed (any window, any cause); returns an unsubscribe */
  onChanged(handler: (statuses: SubscriptionStatusMap) => void): () => void
}
