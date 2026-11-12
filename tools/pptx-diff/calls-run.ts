import { createCallsRunner } from '../docx-diff/calls-runner'
import { ANIM } from './calls-anim'
import { BYTES } from './calls-bytes'
import { GEOM } from './calls-geom'
import { IDENT } from './calls-ident'
import { LAYOUT } from './calls-layout'
import { LEAVES } from './calls-leaves'
import { MTX } from './calls-mtx'
import { PACKAGE } from './calls-package'
import { PLACEHOLDER } from './calls-placeholder'
import { TABLES } from './calls-tables'
import { THEME } from './calls-theme'
import { XML_TREE } from './calls-xml-tree'

export const { callOutcomes, callsOnDocument, callsAfterCorpus, reportCalls } = createCallsRunner({
  xml: XML_TREE,
  leaves: LEAVES,
  package: PACKAGE,
  geom: GEOM,
  layout: LAYOUT,
  tables: TABLES,
  anim: ANIM,
  bytes: BYTES,
  ident: IDENT,
  mtx: MTX,
  theme: THEME,
  placeholder: PLACEHOLDER,
})
