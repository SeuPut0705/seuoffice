/**
 * Skill names never read or shown from any source, compared without case
 * (spec 3.6): the upstream program's skill (this app reads nothing the
 * upstream registered) and this app's own command-line skill, which steers to
 * the terminal command. The one list: `@genoffice/ai-provider` re-exports it.
 *
 * A file with no imports, exported as `@genoffice/agent-core/user-skill-names`:
 * an editor's main process that leaves `@genoffice/ai-provider` unbundled
 * loads this source as it is at run time, and the package root cannot be
 * loaded that way.
 */
export const RESERVED_USER_SKILL_NAMES: ReadonlySet<string> = new Set(['genoffice', 'ieumoffice'])
