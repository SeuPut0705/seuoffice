import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hwpPresentationKeyOf } from '../src/renderer/presentation-keys'

/**
 * HWP leaves F5 and Shift+F5 to Hancom's cell blocks. Ctrl+F5 (Cmd+F5) enters
 * the presenter, which uses fullscreen and the rhwp chrome API.
 */
describe('HWP presentation wiring', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
  const styles = readFileSync(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8')
  const key = (overrides = {}) => ({
    key: 'F5',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  })

  it('leaves F5 and Shift+F5 to cell blocks and presents with Ctrl+F5', () => {
    expect(hwpPresentationKeyOf(key(), false)).toBeNull()
    expect(hwpPresentationKeyOf(key({ shiftKey: true }), false)).toBeNull()
    expect(hwpPresentationKeyOf(key({ ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(hwpPresentationKeyOf(key({ altKey: true, ctrlKey: true }), false)).toBeNull()
    expect(hwpPresentationKeyOf(key({ ctrlKey: true, repeat: true }), false)).toBeNull()
    expect(hwpPresentationKeyOf(key({ ctrlKey: true }), false)).toBe('present-windowed')
    expect(hwpPresentationKeyOf(key({ metaKey: true }), false)).toBe('present-windowed')
  })

  it('ends the show with F5 or Esc, and only then', () => {
    expect(hwpPresentationKeyOf(key(), true)).toBe('exit')
    expect(hwpPresentationKeyOf(key({ shiftKey: true }), true)).toBe('exit')
    expect(hwpPresentationKeyOf(key({ key: 'Escape' }), true)).toBe('exit')
    expect(hwpPresentationKeyOf(key({ key: 'Escape' }), false)).toBeNull()
  })

  it('keeps a key the show takes away from the editor', () => {
    const onKey = app.slice(app.indexOf('const onKey'), app.indexOf("addEventListener('keydown'"))
    expect(onKey).toContain('event.stopPropagation()')
    expect(onKey.indexOf('event.stopPropagation()')).toBeLessThan(
      onKey.indexOf("if (action === 'exit')"),
    )
  })

  it('uses the editor chrome API and fullscreen for the presenter', () => {
    expect(app).toContain('hwpPresentationKeyOf')
    expect(app).toContain('editor.chrome.get()')
    expect(app).toContain('menu: false, toolbar: false, statusbar: false')
    expect(app).toContain('requestFullscreen')
  })

  it('marks the app while presenting and hides the dock and notices', () => {
    expect(app).toContain('hwp-presenting')
    expect(styles).toContain('.hwp-app.hwp-presenting .ai-dock')
    expect(styles).toContain('.hwp-app.hwp-presenting .hwp-notice')
  })
})
