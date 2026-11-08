import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A deck renamed or moved inside the app takes its remembered design template
 * along. The slides main process owns that record; the shell only tells it,
 * from the one function every in-app rename and move goes through.
 * src/main/index.ts needs a running Electron to load, so the wiring is pinned
 * on its source (the move itself is tested in apps/slides).
 */

const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')

/** the body of a top-level function, up to its closing brace at column 0 */
function functionBody(signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `missing: ${signature}`).toBeGreaterThanOrEqual(0)
  return source.slice(start, source.indexOf('\n}', start))
}

describe('slides template memory follows an in-app rename', () => {
  it('afterFileMoved moves the record of a renamed .pptx', () => {
    const body = functionBody('function afterFileMoved(oldPath: string, newPath: string): void {')
    expect(body).toMatch(
      /if \(\/\\\.pptx\$\/i\.test\(newPath\)\) moveSlidesTemplateSelection\(oldPath, newPath\)/,
    )
  })

  it('takes the function from the slides main code', () => {
    expect(source).toMatch(
      /import \{ moveSlidesTemplateSelection \} from '\.\.\/\.\.\/\.\.\/slides\/src\/main\/template-selection-ipc'/,
    )
  })

  it('a folder move reaches it through the same function', () => {
    const body = functionBody('function afterFolderMoved(')
    expect(body).toContain('afterFileMoved(file, rebasePath(file, oldDir, newDir))')
  })
})
