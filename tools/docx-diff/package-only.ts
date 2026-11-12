// Comparison (e) over the built containers alone, for a fault in the package
// layer: seconds instead of the gate's minutes. It checks no floor of the gate,
// so it accepts nothing: the gate does.
//
//   npx tsx tools/docx-diff/package-only.ts [--only TEXT] [--show N]
//
// --only keeps the containers whose name holds TEXT. Every differing path goes
// to out/package-paths.json. SEUOFFICE_WASM runs a wasm built elsewhere, such
// as a copy holding a seeded fault.
import { comparePackage, writePathReport } from './compare-package'
import { Comparison, gateHasFailed, reportComparisons } from './harness'
import { oddContainers } from './package-zips'

const at = process.argv.indexOf('--only')
const only = at < 0 ? '' : process.argv[at + 1]!
const opened = new Comparison('(e) packages opened, built containers', 1)
const values = new Comparison('(e) package values, built containers, checks', 1)

for (const [name, docx] of oddContainers()) {
  if (name.includes(only)) await comparePackage(opened, values, `built "${name}"`, docx)
}

reportComparisons()
writePathReport()
process.exitCode = gateHasFailed() ? 1 : 0
