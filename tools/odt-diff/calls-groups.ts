// The groups of comparison (f), by name: one spec per function of a layer.
import type { CallSpec } from '../docx-diff/calls-spec'
import { ASSEMBLE } from './calls-odtassemble'
import { CORE } from './calls-odtcore'
import { OBJECTS } from './calls-odtobjects'
import { PAGE } from './calls-odtpage'
import { TABLE } from './calls-odttable'
import { TEXT } from './calls-odttext'

export const CALL_GROUPS: Record<string, CallSpec[]> = {
  odtCore: CORE,
  odtText: TEXT,
  odtTable: TABLE,
  odtObjects: OBJECTS,
  odtPage: PAGE,
  odtAssemble: ASSEMBLE,
}
