import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPECS as ATTACHABLE } from './attachable-cases'
import { SPECS as COMPOUND } from './compound-cases'
import { SPECS as CSV } from './csv-cases'
import { SPECS as EPUB } from './epub-cases'
import { SPECS as HIDDEN } from './hidden-content-cases'
import { SPECS as HTML } from './html-cases'
import { SPECS as HWP } from './hwp-cases'
import { SPECS as LEGACY } from './legacy-cases'
import { SPECS as PARSE } from './parse-cases'
import { SPECS as DATES } from './date-cases'
import { SPECS as DOCX } from './docx-cases'
import { hostileZipInputs } from './hostile'
import { SPECS as OPC } from './opc-cases'
import { SPECS as PPTX } from './pptx-cases'
import { SPECS as REDACTION } from './redaction-cases'
import { runSuite } from './runner'
import type { Spec } from './spec'
import { SPECS as XLSX } from './xlsx-cases'
import { SPECS as ZIP_TEXT } from './zip-text-cases'

const withHostile = (spec: Spec): Spec =>
  spec.fn === 'docxToText' ? { ...spec, built: async () => [...await spec.built(), ...hostileZipInputs()] } : spec
// a cycle in a compound file's links can hang or kill the reader, so every compound input runs in a child
const isolated = (spec: Spec): Spec => ({ ...spec, isolate: true })

const passed = await runSuite({
  directory: dirname(fileURLToPath(import.meta.url)),
  groups: {
    opc: OPC, attachable: ATTACHABLE, dates: DATES, redaction: REDACTION,
    docx: DOCX.map(withHostile), pptx: PPTX, xlsx: XLSX, ziptext: ZIP_TEXT, compound: COMPOUND.map(isolated),
    csv: CSV, hidden: HIDDEN, html: HTML, parse: PARSE, legacy: LEGACY.map(isolated), hwp: HWP, epub: EPUB,
  },
})
process.exitCode = passed ? 0 : 1
