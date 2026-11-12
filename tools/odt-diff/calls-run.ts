import { createCallsRunner } from '../docx-diff/calls-runner'
import { CALL_GROUPS } from './calls-groups'

export const {
  callOutcomes,
  callsOnDocument,
  callsOnModel,
  callsAfterCorpus,
  reportCalls,
  listedClasses,
} = createCallsRunner(CALL_GROUPS)
