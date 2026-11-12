import type { Group } from '../types.ts'
import { group as files } from './files.ts'
import { group as nodePath } from './node-path.ts'
import { group as settings } from './settings.ts'
import { group as update } from './update.ts'

/** The groups of batch 1 (decision 0029), by the name `--group` takes. */
export const groups: Record<string, Group> = {
  'node-path': nodePath,
  update,
  settings,
  files,
}
