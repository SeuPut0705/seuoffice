/** Path matching for the rename (codemod.mjs). */
import { LIVE_GUIDES, PATH_CLASSES, PROSE_EXCEPTIONS_TO_RECORD } from './mapping.mjs'

function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches no folder at all
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else out += '[^/]*'
    } else out += /[.+^${}()|[\]\\?]/.test(ch) ? `\\${ch}` : ch
  }
  return new RegExp(`^${out}$`)
}

export const matcher = (globs) => {
  const res = globs.map(globToRegExp)
  return (path) => res.some((re) => re.test(path))
}

const classMatchers = PATH_CLASSES.map((c) => ({ ...c, matches: matcher(c.globs) }))
const proseException = matcher(PROSE_EXCEPTIONS_TO_RECORD)
const liveGuide = matcher(LIVE_GUIDES)

/** The first path class of mapping.mjs that matches, `code` when none does */
export function classOf(path) {
  for (const c of classMatchers) {
    if (!c.matches(path)) continue
    if (c.class === 'record' && liveGuide(path)) return 'guide'
    if (c.class === 'record' && proseException(path)) return 'prose'
    return c.class
  }
  return 'code'
}
