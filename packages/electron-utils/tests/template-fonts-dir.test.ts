// Where the template font set lives: the repo folder in a dev run, the one copy under
// the app's resources once packaged. No Electron here: the app facts are injected.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_FONTS_DIR_NAME,
  TEMPLATE_FONTS_REPO_DIR,
  templateFontsDir,
} from '../src/template-fonts-dir'

const REPO = resolve(import.meta.dirname, '../../..')

describe('templateFontsDir', () => {
  it('points a dev run of any app at the folder in the checkout', () => {
    for (const app of ['shell', 'slides', 'docs', 'sheets']) {
      const dir = templateFontsDir({
        isPackaged: false,
        getAppPath: () => join(REPO, 'apps', app),
        resourcesPath: join(REPO, 'node_modules', 'electron', 'dist', 'resources'),
      })
      expect(dir).toBe(join(REPO, TEMPLATE_FONTS_REPO_DIR))
    }
  })

  it('names a folder that exists in the checkout and holds the readme', () => {
    expect(existsSync(join(REPO, TEMPLATE_FONTS_REPO_DIR, 'README.md'))).toBe(true)
  })

  it('points the packaged app at its resources copy', () => {
    const resources = join('C:', 'Program Files', 'IeumOffice', 'resources')
    const dir = templateFontsDir({
      isPackaged: true,
      getAppPath: () => join(resources, 'app.asar'),
      resourcesPath: resources,
    })
    expect(dir).toBe(join(resources, TEMPLATE_FONTS_DIR_NAME))
    expect(TEMPLATE_FONTS_DIR_NAME).toBe('template-fonts')
  })
})
