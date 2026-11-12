import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSuite } from '../fileparse-diff/runner'
import { SPECS as PACKAGE } from './package-cases'
import { SPECS as PRIMITIVES } from './primitives-cases'
import { SPECS as RANGES } from './ranges-cases'

const passed = await runSuite({
  directory: dirname(fileURLToPath(import.meta.url)),
  command: 'epubCall',
  groups: { primitives: PRIMITIVES, ranges: RANGES, package: PACKAGE },
})
process.exitCode = passed ? 0 : 1
