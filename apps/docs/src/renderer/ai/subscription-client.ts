/**
 * The AI panel's side of the subscription connection. The state machine and
 * the cards' actions are shared by every editor (`@seuoffice/ui`); this file
 * only names the bridge this window exposes.
 */
import {
  useSubscriptionConnection as useSharedSubscriptionConnection,
  type SubscriptionConnection,
} from '@seuoffice/ui'

export type { SubscriptionConnection }

export function useSubscriptionConnection(): SubscriptionConnection {
  return useSharedSubscriptionConnection({
    api: () => window.aiOfficeSubscription,
    help: 'window',
  })
}
