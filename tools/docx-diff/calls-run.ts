// The Word engine's groups use the same runner as the slides engine.
import { ALTCHUNK } from './calls-altchunk'
import { BLANK } from './calls-blank'
import { CHECKBOX } from './calls-checkbox'
import { DOCPROPS } from './calls-docprops'
import { DRAWING } from './calls-drawing'
import { FIELDDISPLAY } from './calls-fielddisplay'
import { FIELDS } from './calls-fields'
import { IMAGES } from './calls-images'
import { MARKERS } from './calls-markers'
import { MATH } from './calls-math'
import { RESOLVE } from './calls-resolve'
import { REVISION } from './calls-revision'
import { createCallsRunner } from './calls-runner'
import { SECTION } from './calls-section'
import { VML } from './calls-vml'

export const { callOutcomes, callsOnDocument, callsAfterCorpus, reportCalls, listedClasses } =
  createCallsRunner({
    altchunk: ALTCHUNK,
    blank: BLANK,
    checkbox: CHECKBOX,
    docprops: DOCPROPS,
    drawing: DRAWING,
    fielddisplay: FIELDDISPLAY,
    fields: FIELDS,
    images: IMAGES,
    markers: MARKERS,
    math: MATH,
    resolve: RESOLVE,
    revision: REVISION,
    section: SECTION,
    vml: VML,
  })
