import { createCallsRunner } from '../docx-diff/calls-runner'
import { ANIM } from './calls-anim'
import { BYTES } from './calls-bytes'
import { CHART } from './calls-chart'
import { PARSE } from './calls-parse'
import { DECKCORE } from './calls-deckcore'
import { DECKGROUPS } from './calls-deckgroups'
import { DECKSHAPE } from './calls-deckshape'
import { DECKSLIDES } from './calls-deckslides'
import { DECKTABLES } from './calls-decktables'
import { DECKTEXT } from './calls-decktext'
import { GENERATE } from './calls-generate'
import { INSERT } from './calls-insert'
import { LAYOUTS } from './calls-layouts'
import { MEDIA } from './calls-media'
import { PACKAGEPARTS } from './calls-packageparts'
import { GEOM } from './calls-geom'
import { IDENT } from './calls-ident'
import { LAYOUT } from './calls-layout'
import { LEAVES } from './calls-leaves'
import { MTX } from './calls-mtx'
import { PACKAGE } from './calls-package'
import { PLACEHOLDER } from './calls-placeholder'
import { ROUNDTRIP } from './calls-roundtrip'
import { TABLES } from './calls-tables'
import { TABLESTYLE } from './calls-tablestyle'
import { THEME } from './calls-theme'
import { XML_TREE } from './calls-xml-tree'

export const { callOutcomes, callsOnDocument, callsAfterCorpus, reportCalls, listedClasses } =
  createCallsRunner({
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
    tablestyle: TABLESTYLE,
    chart: CHART,
    parse: PARSE,
    deckcore: DECKCORE,
    deckgroups: DECKGROUPS,
    deckshape: DECKSHAPE,
    deckslides: DECKSLIDES,
    decktables: DECKTABLES,
    decktext: DECKTEXT,
    generate: GENERATE,
    insert: INSERT,
    layouts: LAYOUTS,
    media: MEDIA,
    packageparts: PACKAGEPARTS,
    roundtrip: ROUNDTRIP,
  })
