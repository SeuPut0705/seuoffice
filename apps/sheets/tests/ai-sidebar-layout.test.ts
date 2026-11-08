/**
 * Settings › "show the AI sidebar" off and the panel closed: AiChatPanel renders
 * nothing, so `.sheet-body` must drop the panel's grid track as well. Left in
 * place, the only child (`.sheet-main`) is laid out in the collapsed 34px track
 * and the rest of the body stays blank — the white sheet area reported against
 * 0.12.4.
 *
 * Grid placement is CSS, so this pins the wiring and the two rules instead of
 * mounting Univer (jsdom cannot lay out grid items).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (file: string) => readFileSync(join(appRoot, file), 'utf8')

const shell = source('src/renderer/ExcelShell.tsx')
const css = source('src/renderer/styles.css')

/** Body of the `selector { ... }` rule in the stylesheet. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} is missing from styles.css`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

describe('the AI sidebar switch leaves the sheet the whole width', () => {
  it('marks the body when the switch is off and the panel is closed', () => {
    expect(shell).toContain('!aiSidebarEnabled && !aiDock.open')
    expect(shell).toContain("' ai-dock-off'")
  })

  it('drops the panel track for that state', () => {
    expect(ruleBody('.app-shell .sheet-body.ai-dock-off')).toContain(
      'grid-template-columns: minmax(0, 1fr)',
    )
  })

  it('drops the track while presentation hides the panel', () => {
    expect(ruleBody('.app-shell.sheet-presenting .sheet-body')).toContain(
      'grid-template-columns: minmax(0, 1fr)',
    )
  })
})
