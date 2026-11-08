import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { OFFICE_TYPES } from '../src/main/default-app'

/**
 * .odt is offered in Explorer's "Open with" and never made the default: the
 * NSIS script registers a product-own ProgId and one value under
 * .odt\OpenWithProgids, and the uninstaller removes exactly those two. The
 * installer itself can only be checked by installing it, so this pins the
 * script text and the packaging config that keep ODT off the default path.
 */
const require = createRequire(import.meta.url)
const SHELL = resolve(import.meta.dirname, '..')
const nsh = readFileSync(join(SHELL, 'build/installer.nsh'), 'utf8')

function loadBuilderConfig(platform: string) {
  const configModule = { exports: {} as ReturnType<typeof require> }
  runInNewContext(readFileSync(join(SHELL, 'electron-builder.cjs'), 'utf8'), {
    module: configModule,
    __dirname: SHELL,
    process: { platform, arch: 'x64', env: {} },
    require: (id: string) =>
      id === 'node:fs' ? { ...require(id), existsSync: () => true } : require(id),
  })
  return configModule.exports
}

/** body of one `!macro NAME` … `!macroend` block */
function macroBody(name: string): string {
  const match = nsh.match(new RegExp(`!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)\\n!macroend`))
  if (!match) throw new Error(`no ${name} macro in installer.nsh`)
  return match[1]
}

/** the instructions of a macro, comments dropped */
function instructions(name: string): string[] {
  return macroBody(name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith(';'))
}

const PROGID = 'IeumOffice.OpenDocumentText'
const UPSTREAM_PROGIDS = ['Word Document', 'Excel Workbook', 'PowerPoint Presentation']

describe('the ODT "Open with" registration', () => {
  it('uses a ProgId of this product that the upstream app never registers', () => {
    expect(nsh).toContain(`!define GENOFFICE_ODT_PROGID "${PROGID}"`)
    expect(PROGID).toMatch(/^IeumOffice\.[A-Za-z][A-Za-z0-9]*$/)
    // Windows limits a ProgId to 39 characters
    expect(PROGID.length).toBeLessThanOrEqual(39)
    expect(UPSTREAM_PROGIDS).not.toContain(PROGID)
    expect(PROGID.toLowerCase()).not.toContain('genoffice')
  })

  it('writes the ProgId with an open command and an icon, and offers it for .odt', () => {
    const body = instructions('GenOfficeRegisterOpenWithOdt')
    const progKey = 'Software\\Classes\\${GENOFFICE_ODT_PROGID}'
    expect(body).toContain(
      `WriteRegStr SHELL_CONTEXT "${progKey}\\shell\\open\\command" "" '"$appExe" "%1"'`,
    )
    expect(body).toContain(
      `WriteRegStr SHELL_CONTEXT "${progKey}\\DefaultIcon" "" "$INSTDIR\\resources\\docx.ico"`,
    )
    expect(body).toContain(
      'WriteRegNone SHELL_CONTEXT "Software\\Classes\\.odt\\OpenWithProgids" "${GENOFFICE_ODT_PROGID}"',
    )
  })

  it('never writes the default value of .odt or any other .odt key', () => {
    const odtWrites = instructions('GenOfficeRegisterOpenWithOdt').filter((line) =>
      line.includes('\\.odt'),
    )
    // the OpenWithProgids value is the only thing written under .odt
    expect(odtWrites).toEqual([
      'WriteRegNone SHELL_CONTEXT "Software\\Classes\\.odt\\OpenWithProgids" "${GENOFFICE_ODT_PROGID}"',
    ])
    expect(nsh).not.toMatch(/"Software\\Classes\\\.odt" ""/)
    expect(nsh).not.toMatch(/\.odt\\ShellNew/)
  })

  it('removes only its own value and its own ProgId on uninstall', () => {
    expect(instructions('GenOfficeUnregisterOpenWithOdt')).toEqual([
      'DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.odt\\OpenWithProgids" "${GENOFFICE_ODT_PROGID}"',
      'DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${GENOFFICE_ODT_PROGID}"',
    ])
    // the .odt key and its OpenWithProgids list belong to other programs too
    expect(nsh).not.toMatch(/DeleteRegKey[^\n]*\\\.odt/)
  })

  it('runs the registration on install and the removal on uninstall', () => {
    expect(macroBody('customInstall')).toContain('!insertmacro GenOfficeRegisterOpenWithOdt')
    expect(macroBody('customUnInstall')).toContain('!insertmacro GenOfficeUnregisterOpenWithOdt')
    // the ProgId leans on the Word icon the installer places for the .docx
    // association, so that association and its icon must stay
    const win = loadBuilderConfig('win32')
    const docx = win.win.fileAssociations.find((entry: { ext: string }) => entry.ext === 'docx')
    expect(docx?.icon).toBe('docx')
    expect(existsSync(join(SHELL, 'build/docx.ico'))).toBe(true)
  })
})

describe('ODT stays off the default-program path', () => {
  it('is not an electron-builder file association on any platform', () => {
    // a fileAssociations entry makes NSIS write .odt's default value (the
    // ProgId becomes the default opener); mac and Linux are not shipped
    for (const platform of ['win32', 'darwin', 'linux']) {
      const config = loadBuilderConfig(platform)
      expect(config.fileAssociations).toBeUndefined()
      for (const target of ['win', 'mac', 'linux'] as const) {
        const exts = config[target].fileAssociations.map((entry: { ext: string }) => entry.ext)
        expect(exts, `${target} on ${platform}`).not.toContain('odt')
      }
    }
  })

  it('is not one of the types the app offers to become the default for', () => {
    expect(OFFICE_TYPES.map((type) => type.ext)).not.toContain('odt')
  })
})
