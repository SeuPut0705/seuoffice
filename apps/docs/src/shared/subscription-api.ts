// Contract between the docs renderer (AI panel) and the main process for the
// subscription providers (Claude, Codex). The request channels and payloads are
// the shared ones from @genoffice/ai-provider; this is the shape the shell
// exposes to its own renderer (apps/shell/src/shared/subscription-api.ts).

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
  isSubscriptionProviderId,
  subscriptionLaunchResultOf,
  subscriptionStatusMapOf,
} from '@genoffice/ai-provider/browser'

/** exposed on `window.aiOfficeSubscription` by the docs preload */
export interface SubscriptionApi {
  /** the last known connection statuses (`checking` until a first check answered) */
  statuses(): Promise<SubscriptionStatusMap>
  /** look again (both providers when none is named) and answer when done */
  recheck(providers?: AiSubscriptionProviderId[]): Promise<SubscriptionStatusMap>
  /** open the program's own sign-in */
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
