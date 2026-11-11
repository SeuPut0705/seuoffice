import { useEffect, useRef } from 'react'
import { isMadeUpSkillName } from './skill-picker-model'

/**
 * The name a new skill gets from its title while the person has not typed a
 * name of their own (decision 0128). The main process makes the name
 * (`suggestName`): the title's Latin letters and digits as a slug, or a
 * made-up name (`skill-<6 random>`) when the title has none.
 */

/** `suggestName` of the window's skills bridge */
export type SuggestSkillName = (title: string) => Promise<unknown>

/** Wait after the last keystroke in the title before a name is asked for */
export const NAME_FROM_TITLE_DELAY_MS = 250

/**
 * The name for `title`, given the name filled in so far. An empty title
 * empties the name. A made-up name already filled in stays while the title
 * still gives none of its own, so typing on does not make up another one. A
 * failed call keeps what is there.
 */
export async function nameFromTitle(
  title: string,
  current: string,
  suggest: SuggestSkillName,
): Promise<string> {
  if (!title.trim()) return ''
  const name = await Promise.resolve()
    .then(() => suggest(title))
    .catch(() => undefined)
  if (typeof name !== 'string' || !name) return current
  return isMadeUpSkillName(name) && isMadeUpSkillName(current) ? current : name
}

/** Fill the name from the title as it is typed, while `follows` holds */
export function useNameFromTitle(options: {
  title: string
  /** the name still follows the title (nobody gave or typed one) */
  follows: boolean
  /** the name as it is now */
  name: string
  suggest: SuggestSkillName | null | undefined
  onName: (name: string) => void
}): void {
  const { title, follows } = options
  const canSuggest = !!options.suggest
  const latest = useRef(options)
  latest.current = options
  const seq = useRef(0)
  useEffect(() => {
    if (!follows || !canSuggest) return
    const run = ++seq.current
    const timer = setTimeout(() => {
      const { suggest, name: current } = latest.current
      if (!suggest) return
      void nameFromTitle(title, current, (text) => suggest(text)).then((name) => {
        const now = latest.current
        if (run !== seq.current || !now.follows || name === now.name) return
        now.onName(name)
      })
    }, NAME_FROM_TITLE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [title, follows, canSuggest])
}
