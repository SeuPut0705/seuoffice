/**
 * Group `b3-projects`: apps/shell/src/main/projects/ and the pieces of
 * packages/project-store it calls. Each part holds the modules of one slice;
 * the Rust side is crates/main-core/src/calls/b3_projects/<part>.rs.
 */
import type { Group } from '../types.ts'
import { cloud } from './b3-projects-cloud.ts'
import { foundation } from './b3-projects-foundation.ts'
import { guard } from './b3-projects-guard.ts'

export const group: Group = { ...foundation, ...cloud, ...guard }
