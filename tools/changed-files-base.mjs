// Prints the commit CI's changed-file checks (format, theme colors, inline rules,
// font-metric provenance, skill versions) compare against, and fails instead of
// printing nothing: an empty base makes those checks look at no file and pass.
//
//   pull request   the merge commit's first parent, the main it was built against
//   main           the last main commit whose CI run passed (LAST_GREEN_MAIN), so a
//                  run started by hand and a push whose run was cancelled still have
//                  every file since the last checked commit looked at
//   other branch   where the branch left origin/main, so a branch is checked on
//                  everything it would bring into main
//
// Environment: GITHUB_EVENT_NAME, GITHUB_REF, LAST_GREEN_MAIN.
import { spawnSync } from 'node:child_process'

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function fail(message) {
  console.error(`changed-files-base: ${message}`)
  process.exit(1)
}

const event = process.env.GITHUB_EVENT_NAME ?? ''
const ref = process.env.GITHUB_REF ?? ''

let base
if (event === 'pull_request') {
  base = git('rev-parse', 'HEAD^1')
} else if (ref === 'refs/heads/main') {
  base = (process.env.LAST_GREEN_MAIN ?? '').trim()
  if (!base) fail('no main commit with a passing CI run was given (LAST_GREEN_MAIN)')
} else {
  base = git('merge-base', 'HEAD', 'origin/main')
  if (!base) fail('this branch shares no history with origin/main')
}

const commit = git('rev-parse', '--verify', '--quiet', `${base}^{commit}`)
if (!commit || /^0+$/.test(commit))
  fail(`base ${base || '(empty)'} is not a commit in this checkout`)
console.log(commit)
