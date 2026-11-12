/**
 * Skill names never read or shown from any source, compared without case
 * (spec 3.6): the upstream program's skill (this app reads nothing the
 * upstream registered) and this app's own command-line skill under its
 * current and earlier names, which steers to the terminal command. The one
 * list: `@seuoffice/ai-provider` re-exports it.
 *
 * A file with no imports, exported as `@seuoffice/agent-core/user-skill-names`:
 * an editor's main process that leaves `@seuoffice/ai-provider` unbundled
 * loads this source as it is at run time, and the package root cannot be
 * loaded that way. So the earlier names are written here, not imported from
 * `old-names.ts`; the rename tool keeps the UPSTREAM_AND_EARLIER_NAMES line
 * as it is.
 */
const UPSTREAM_AND_EARLIER_NAMES = ['genoffice', 'ieumoffice']
export const RESERVED_USER_SKILL_NAMES: ReadonlySet<string> = new Set([
  ...UPSTREAM_AND_EARLIER_NAMES,
  'seuoffice',
])
