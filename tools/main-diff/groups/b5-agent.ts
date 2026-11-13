import type { Group } from '../types.ts'

/**
 * Batch 5's agent, skill, generate and editor AI modules, one table per part.
 * The parts load one after another, each after electron-fake.ts, and no
 * function may be named by two parts.
 */
const parts = [
  () => import('./b5-agent-sessions.ts'),
  () => import('./b5-agent-skills.ts'),
  () => import('./b5-agent-user-skills.ts'),
  () => import('./b5-agent-generate.ts'),
  () => import('./b5-agent-slides-ai.ts'),
  () => import('./b5-agent-apps.ts'),
]

const merged: Group = {}
for (const load of parts) {
  const { group } = await load()
  for (const [name, spec] of Object.entries(group)) {
    if (name in merged) throw new Error(`b5-agent: ${name} is in two parts`)
    merged[name] = spec
  }
}

export const group: Group = merged
