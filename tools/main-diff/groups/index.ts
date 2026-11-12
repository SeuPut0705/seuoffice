import type { Group } from '../types.ts'
import { group as b2Misc } from './b2-misc.ts'
import { group as b2Print } from './b2-print.ts'
import { group as b2Recovery } from './b2-recovery.ts'
import { group as b2Remote } from './b2-remote.ts'
import { group as b3Session } from './b3-session.ts'
import { group as b3Shell } from './b3-shell.ts'
import { group as b3Update } from './b3-update.ts'
import { group as files } from './files.ts'
import { group as nodeFs } from './node-fs.ts'
import { group as nodePath } from './node-path.ts'
import { group as settings } from './settings.ts'
import { group as update } from './update.ts'

/** The groups of each batch (decision 0029), by the name `--group` takes. */
export const groups: Record<string, Group> = {
  'node-path': nodePath,
  update,
  settings,
  files,
  'node-fs': nodeFs,
  'b2-misc': b2Misc,
  'b2-recovery': b2Recovery,
  'b2-remote': b2Remote,
  'b2-print': b2Print,
  'b3-session': b3Session,
  'b3-update': b3Update,
  'b3-shell': b3Shell,
}
