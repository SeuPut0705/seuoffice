import type { Group } from '../types.ts'

/**
 * Batch 5's AI runtime: the provider protocols, the subscription bridges and
 * Google Drive (packages/ai-provider/src, packages/google-drive/src), one
 * table per part (groups/b5-provider/*.ts). The async functions run in the
 * scripted world of b5-provider/world.ts. No function may be named by two
 * parts.
 */
const parts = [
  () => import('./b5-provider/fetch.ts'),
  () => import('./b5-provider/openai.ts'),
  () => import('./b5-provider/anthropic.ts'),
  () => import('./b5-provider/keys.ts'),
  () => import('./b5-provider/media.ts'),
  () => import('./b5-provider/chatgpt.ts'),
  () => import('./b5-provider/subscription.ts'),
  () => import('./b5-provider/launch.ts'),
  () => import('./b5-provider/codex.ts'),
  () => import('./b5-provider/claude.ts'),
  () => import('./b5-provider/agent.ts'),
  () => import('./b5-provider/drive.ts'),
  () => import('./b5-provider/route.ts'),
]

const merged: Group = {}
for (const load of parts) {
  const { group } = await load()
  for (const [name, spec] of Object.entries(group)) {
    if (name in merged) throw new Error(`b5-provider: ${name} is in two parts`)
    merged[name] = spec
  }
}

export const group: Group = merged
