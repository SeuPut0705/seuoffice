import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSuite } from '../fileparse-diff/runner'
import { SPECS as PACKAGE } from './package-cases'
import { SPECS as PRIMITIVES } from './primitives-cases'
import { SPECS as PURE } from './pure-cases'
import { SPECS as RANGES } from './ranges-cases'
import { SPECS as SAXES } from './saxes-cases'
import { SPECS as XML } from './xml-cases'

const passed = await runSuite({
  directory: dirname(fileURLToPath(import.meta.url)),
  command: 'epubCall',
  groups: {
    primitives: PRIMITIVES,
    ranges: RANGES,
    package: PACKAGE,
    saxes: SAXES,
    pure: PURE,
    xml: XML,
  },
})
process.exitCode = passed ? 0 : 1
