/**
 * The ChatGPT connection as a subscription status. Nothing is started and
 * nothing goes over the network: a stored session is `ready` (it is scoped to
 * the ChatGPT plan alone, so it is never metered), no session is `signed-out`.
 * A session OpenAI no longer accepts is found by the next request or refresh,
 * which drops it, and the status follows.
 */
import { subscriptionStatusErrorText } from '../subscription/contract'
import type { SubscriptionDetection } from '../subscription/status'
import { chatGptConnection, type ChatGptConnection } from './connection'

export async function detectChatGptConnection(
  connection: ChatGptConnection | null = chatGptConnection(),
): Promise<SubscriptionDetection> {
  // a process without the connection (the terminal command) cannot run on it
  if (!connection) return { provider: 'chatgpt', state: 'signed-out' }
  try {
    const state = await connection.state()
    if (!state.signedIn) return { provider: 'chatgpt', state: 'signed-out' }
    return {
      provider: 'chatgpt',
      state: 'ready',
      loginMethod: 'subscription',
      ...(state.account ? { account: state.account } : {}),
    }
  } catch {
    return {
      provider: 'chatgpt',
      state: 'error',
      error: subscriptionStatusErrorText('failed', 'The ChatGPT connection could not be read'),
    }
  }
}
