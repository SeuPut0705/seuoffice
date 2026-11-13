/**
 * Group `b3-projects`: apps/shell/src/main/projects/ and the pieces of
 * packages/project-store it calls. Each part holds the modules of one slice;
 * the Rust side is crates/main-core/src/calls/b3_projects/<part>.rs.
 */
import type { Group } from '../types.ts'
import { chats } from './b3-projects-chats.ts'
import { cloud } from './b3-projects-cloud.ts'
import { files } from './b3-projects-files.ts'
import { foundation } from './b3-projects-foundation.ts'
import { guard } from './b3-projects-guard.ts'
import { guide } from './b3-projects-guide.ts'
import { ipc } from './b3-projects-ipc.ts'

export const group: Group = {
  ...foundation,
  ...cloud,
  ...guard,
  ...files,
  ...chats,
  ...ipc,
  ...guide,
}
