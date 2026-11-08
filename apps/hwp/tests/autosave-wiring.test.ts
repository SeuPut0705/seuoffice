import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

describe('HWP autosave wiring', () => {
  it('shows the shared AutoSave toggle and saves with the automatic flag', () => {
    const app = source('src/renderer/App.tsx')
    expect(app).toContain("useAutoSavePref('hwpapp.autoSave', window.hwpApi)")
    expect(app).toContain('startAutosave({')
    expect(app).toContain("save: () => save('save', true)")
    expect(app).toContain('className="hwp-topbar"')
  })

  it('passes the automatic flag through preload and commit-save', () => {
    const preload = source('src/preload/index.ts')
    expect(preload).toContain('HWP_CHANNELS.getAutoSaveDefault')
    expect(preload).toContain('HWP_CHANNELS.autoSaveDefaultChanged')
    // the flag travels in the options object, next to the memo list of a HWPX save
    expect(preload).toContain('HWP_CHANNELS.commitSave, bytes, tabs, options')
    const flow = source('src/renderer/save-flow.ts')
    expect(flow).toContain('automatic = false')
    expect(flow).toContain('auto: automatic')
    expect(source('src/main/hwp-main.ts')).toContain('if (saveOptions.auto) {')
  })
})
