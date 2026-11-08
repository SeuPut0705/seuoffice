// Weekly look at OpenRouter's public model list against the free models the app
// offers. Reads no key and spends no free request. Prints a Markdown report
// (what the free-models workflow puts in its run summary), or JSON with --json.
// Exit 0: nothing to act on. 1: an offered model is gone, or a new candidate is
// there to try. 2: the list could not be read.
import { spawnSync } from 'node:child_process'
import {
  compareFreeModels,
  fetchCatalog,
  needsAction,
  readListed,
  readRejected,
  reportMarkdown,
} from './free-models.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const unknown = args.find((a) => a !== '--json')
if (unknown) {
  console.error(`Unexpected argument: ${unknown}`)
  process.exit(2)
}

const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()

// exit codes are set, not process.exit()ed: on Windows exiting while the
// fetch's handles close aborts Node
try {
  const result = compareFreeModels({
    listed: readListed(root),
    rejected: readRejected(root),
    catalog: await fetchCatalog(),
  })
  process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : reportMarkdown(result))
  process.exitCode = needsAction(result) ? 1 : 0
} catch (error) {
  console.error(`check-free-models: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
