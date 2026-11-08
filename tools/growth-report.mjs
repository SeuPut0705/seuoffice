/**
 * Print the growth digest from the tracked history file, for the daily GitHub
 * Actions run, a local check-in, or the weekly review.
 *
 * Usage: node tools/growth-report.mjs [history-file]
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderReport } from './growth-log.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = process.argv[2]
const historyPath = arg ? resolve(arg) : join(ROOT, 'docs/tracking/growth-history.json')

let history
try {
  history = JSON.parse(readFileSync(historyPath, 'utf8'))
} catch (error) {
  console.error(`Cannot read growth history at ${historyPath}: ${error.message}`)
  process.exit(1)
}

console.log(renderReport(history))
