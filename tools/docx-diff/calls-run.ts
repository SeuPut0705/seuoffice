// The Word engine's groups use the same runner as the slides engine.
import { ALTCHUNK } from './calls-altchunk'
import { BLANK } from './calls-blank'
import { BLOCKPASSES } from './calls-blockpasses'
import { CHART } from './calls-chart'
import { CHARCLASS, XMLTAG } from './calls-charclass'
import { CHECKBOX } from './calls-checkbox'
import { DOCPROPS } from './calls-docprops'
import { DRAWING } from './calls-drawing'
import { FIELDDISPLAY } from './calls-fielddisplay'
import { FIELDS } from './calls-fields'
import { GEN_DRAWING } from './calls-gen-drawing'
import { GEN_DRAWING_BUILD } from './calls-gen-drawing-build'
import { GEN_FIELDS } from './calls-gen-fields'
import { GEN_PARAGRAPH } from './calls-gen-paragraph'
import { GEN_PROPS } from './calls-gen-props'
import { GEN_RPR } from './calls-gen-rpr'
import { GEN_RUNS } from './calls-gen-runs'
import { GEN_TABLE } from './calls-gen-table'
import { GEN_TEXT } from './calls-gen-text'
import { IMAGES } from './calls-images'
import { INK } from './calls-ink'
import { MARKERS } from './calls-markers'
import { MATH } from './calls-math'
import { PARSE } from './calls-parse'
import { RESOLVE } from './calls-resolve'
import { REVISION } from './calls-revision'
import { SAVE } from './calls-save'
import { createCallsRunner } from './calls-runner'
import { SECTION } from './calls-section'
import { VML } from './calls-vml'

export const {
  callOutcomes,
  callsOnDocument,
  callsOnParse,
  callsOnModel,
  callsAfterCorpus,
  reportCalls,
  callsReport,
  listedClasses,
} = createCallsRunner({
  altchunk: ALTCHUNK,
  blank: BLANK,
  blockpasses: BLOCKPASSES,
  chart: CHART,
  charclass: CHARCLASS,
  checkbox: CHECKBOX,
  docprops: DOCPROPS,
  drawing: DRAWING,
  fielddisplay: FIELDDISPLAY,
  fields: FIELDS,
  images: IMAGES,
  ink: INK,
  parse: PARSE,
  markers: MARKERS,
  math: MATH,
  resolve: RESOLVE,
  revision: REVISION,
  save: SAVE,
  section: SECTION,
  vml: VML,
  xmltag: XMLTAG,
  genRpr: GEN_RPR,
  genProps: GEN_PROPS,
  genDrawing: GEN_DRAWING,
  genDrawingBuild: GEN_DRAWING_BUILD,
  genText: GEN_TEXT,
  genTable: GEN_TABLE,
  genFields: GEN_FIELDS,
  genRuns: GEN_RUNS,
  genParagraph: GEN_PARAGRAPH,
})
