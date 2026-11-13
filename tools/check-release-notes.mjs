#!/usr/bin/env node
// The notes the update window shows for a release: docs/seuoffice/판-노트/<version>.md,
// one "- " line per change a person notices, in the person's words. A release
// without them does not go out (decision 0027): this runs before any build.
//
//   node tools/check-release-notes.mjs 0.12.43          # checks, exit 1 when not fit
//   node tools/check-release-notes.mjs 0.12.43 --print  # and prints the release body
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIN_ITEMS = 1
const MAX_ITEMS = 6
const MAX_ITEM_CHARS = 200

/** what a commit log says and a person reading the update window does not need */
const COMMIT_SPEAK = [
  [/\b[0-9a-f]{7,40}\b/, 'a commit id'],
  [/^(?:feat|fix|test|docs|chore|refactor|perf|ci|build)(?:\([^)]*\))?!?:/, 'a commit type'],
  [/(?:^|\s)#\d+\b/, 'an issue number'],
  [/결정 \d{4}|decision \d{4}/i, 'a decision number'],
  [/`/, 'code formatting'],
]

export function checkNotes(text) {
  const problems = []
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const items = []
  for (const line of lines) {
    if (!line.startsWith('- ')) {
      problems.push(`not a "- " item: ${line}`)
      continue
    }
    const item = line.slice(2).trim()
    if (item === '') problems.push('an empty item')
    if (item.length > MAX_ITEM_CHARS) problems.push(`longer than ${MAX_ITEM_CHARS}: ${item}`)
    for (const [pattern, what] of COMMIT_SPEAK) {
      if (pattern.test(item)) problems.push(`${what} in: ${item}`)
    }
    items.push(item)
  }
  if (items.length < MIN_ITEMS) problems.push('no change listed')
  if (items.length > MAX_ITEMS)
    problems.push(`${items.length} items; keep the ${MAX_ITEMS} that matter`)
  return { items, problems }
}

function main() {
  const [version, flag] = process.argv.slice(2)
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('usage: check-release-notes.mjs <version> [--print]')
    process.exit(2)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const file = join(root, 'docs', 'seuoffice', '판-노트', `${version}.md`)
  if (!existsSync(file)) {
    console.error(`no release notes: write docs/seuoffice/판-노트/${version}.md first`)
    process.exit(1)
  }
  const { items, problems } = checkNotes(readFileSync(file, 'utf8'))
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  if (flag === '--print') process.stdout.write(items.map((item) => `- ${item}`).join('\n') + '\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
