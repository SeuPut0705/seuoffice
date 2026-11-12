import { createCallsRunner } from '../docx-diff/calls-runner'
import { LEAVES } from './calls-leaves'
import { PACKAGE } from './calls-package'
import { XML_TREE } from './calls-xml-tree'

export const { callOutcomes, callsOnDocument, callsAfterCorpus, reportCalls } = createCallsRunner({
  xml: XML_TREE,
  leaves: LEAVES,
  package: PACKAGE,
})
