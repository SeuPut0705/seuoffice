import { join } from 'node:path'

/**
 * The builtin skills folder: next to the app's other resources once packaged
 * (`resources/builtin-skills`), the repository copy in a development run.
 */
export function builtinSkillsDirFor(options: {
  isPackaged: boolean
  resourcesPath: string
  /** `app.getAppPath()`: the shell package folder in a development run */
  appPath: string
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'builtin-skills')
    : join(options.appPath, 'resources', 'builtin-skills')
}
