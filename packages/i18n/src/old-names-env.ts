/**
 * Loading this module takes over the environment variables a person was told
 * to set under the old prefix (`OLD_ENV_NAMES` in old-names.ts).
 *
 * Every process entry point imports it as its first import, on a line of its
 * own, so no module evaluated after it reads a variable before the take-over:
 * the Electron main of the shell and of each editor, the worker and utility
 * process entries, the command's entry. `tests/env-entry-points.old-names.test.ts`
 * lists the entry points from the build configurations and fails when one
 * does not.
 *
 * Imports nothing but the registry, so it costs an entry point nothing.
 */
import { adoptOldEnv } from './old-names'

// a renderer has no `process`: there the module does nothing
const host = globalThis as { process?: { env?: Record<string, string | undefined> } }
if (host.process?.env) adoptOldEnv(host.process.env)
