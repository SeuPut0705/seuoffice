/**
 * The models a subscription CLI offers, asked of the CLI itself and without a
 * model call: Claude Code names them in its answer to the setup request, Codex
 * through its app-server's `model/list`. Each bridge registers how its list is
 * read; this file only bounds the asking, so the status service does not import
 * the bridges.
 *
 * A list is display data for the model picker. Reading it is never allowed to
 * hold up or fail a connection status: every failure here is "no list".
 */
import type { AiSubscriptionModel, AiSubscriptionProviderId } from '../types'
import { subscriptionModelsOf } from './contract'

/** How long a CLI is given to list its models */
export const SUBSCRIPTION_MODELS_TIMEOUT_MS = 20_000

/**
 * Reads one CLI's model list. Supplied by that CLI's bridge. `signal` is
 * aborted when the answer is no longer waited for, and always once the reading
 * is over: whatever the source started must end with it.
 */
export type SubscriptionModelSource = (context: {
  /** the configured path of the CLI, as stored in the settings */
  configuredPath: string | undefined
  signal: AbortSignal
}) => Promise<unknown>

const sources = new Map<AiSubscriptionProviderId, SubscriptionModelSource>()

/** Let a bridge supply its CLI's model list to the status check. Pass null to remove it. */
export function setSubscriptionModelSource(
  provider: AiSubscriptionProviderId,
  source: SubscriptionModelSource | null,
): void {
  if (source) sources.set(provider, source)
  else sources.delete(provider)
}

export interface SubscriptionModelListOptions {
  /** the user's own path to the CLI (the `cliPath` setting) */
  configuredPath?: string | undefined
  timeoutMs?: number | undefined
}

/** The model list of one provider, or undefined when there is none to show */
export type SubscriptionModelLister = (
  provider: AiSubscriptionProviderId,
  options?: SubscriptionModelListOptions,
) => Promise<AiSubscriptionModel[] | undefined>

/**
 * The models `provider`'s CLI lists, through the source its bridge registered.
 * Never rejects: no bridge loaded, a CLI too old to answer, a failure and an
 * answer that outlasts `timeoutMs` are all "no list". The list goes through
 * `subscriptionModelsOf`, so only its listed, bounded fields come back.
 */
export const listSubscriptionModels: SubscriptionModelLister = async (provider, options = {}) => {
  const source = sources.get(provider)
  if (!source) return undefined
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      () => resolve(undefined),
      options.timeoutMs ?? SUBSCRIPTION_MODELS_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => source({ configuredPath: options.configuredPath, signal: controller.signal }))
        // the message of a failure is not kept: it may carry what the CLI printed
        .then(subscriptionModelsOf, () => undefined),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
    // ends whatever the source still has running, on a timeout and otherwise
    controller.abort()
  }
}
