// Group `parse`: the internal functions of parse.ts, ported leaf first
// (crates/docx-engine/src/parse/). Their corpus inputs are the arguments
// parseDocx calls them with (fromParse, parse-internals.ts).
import type { CallSpec } from './calls-spec'
import { PARSE_DRAWINGS } from './calls-parse-drawings'
import { PARSE_TABLES } from './calls-parse-tables'
import { PARSE_TEXT } from './calls-parse-text'

export const PARSE: CallSpec[] = [...PARSE_TEXT, ...PARSE_TABLES, ...PARSE_DRAWINGS]
