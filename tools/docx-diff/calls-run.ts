// The Word engine's groups use the same runner as the slides engine.
import { BLANK } from './calls-blank'
import { DOCPROPS } from './calls-docprops'
import { FIELDS } from './calls-fields'
import { MARKERS } from './calls-markers'
import { MATH } from './calls-math'
import { SECTION } from './calls-section'
import { createCallsRunner } from './calls-runner'

export const { callOutcomes, callsOnDocument, callsAfterCorpus, reportCalls } = createCallsRunner({
  blank: BLANK,
  docprops: DOCPROPS,
  fields: FIELDS,
  markers: MARKERS,
  math: MATH,
  section: SECTION,
})
