import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { isSupportedTreeFile } from '../src/main/folder-tree'
import { EXT_FAMILY } from '../src/main/recent-files'

/**
 * `.odt` is a Word document everywhere the shell lists or opens files. The main
 * entry (src/main/index.ts) and Home.tsx cannot be imported in a node test, so
 * their lists and menu wiring are read out of the source, the same way
 * main-locale-tables.test.ts does.
 */
const main = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
const home = readFileSync(join(__dirname, '../src/renderer/src/Home.tsx'), 'utf8')

/** the declaration `const NAME …` up to the blank line that ends it */
function literal(source: string, name: string): string {
  const start = source.indexOf(`const ${name}`)
  if (start < 0) throw new Error(`no ${name}`)
  const end = source.indexOf('\n\n', start)
  return source.slice(start, end < 0 ? undefined : end)
}

/** a menu builder's source, from `function NAME(` to the next top-level function */
function fnSource(name: string): string {
  const start = main.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no ${name}`)
  const end = main.indexOf('\nfunction ', start + 1)
  return main.slice(start, end < 0 ? undefined : end)
}

/** one locale's slice of the main-process table, from `xx: {` to the next header */
function localeBlock(locale: string): string {
  const head = locale.includes('-') ? `'${locale}'` : locale
  const start = main.indexOf(`\n  ${head}: {\n`)
  if (start < 0) throw new Error(`no ${locale} block`)
  const rest = main.slice(start + 1)
  const end = rest.search(/\n {2}\S+: \{/)
  return end < 0 ? rest : rest.slice(0, end)
}

describe('ODT in the shell lists', () => {
  it('counts .odt as a Word document in every docx family list', () => {
    expect(EXT_FAMILY.docx).toContain('odt')
    expect(literal(main, 'SEARCH_EXT_FAMILY')).toMatch(/docx: \['docx', 'doc', 'odt'\]/)
    expect(literal(home, 'FILTER_FAMILY')).toMatch(/docx: \['docx', 'doc', 'odt'\]/)
  })

  it('shows .odt in the folder tree, the open dialog and the open card', () => {
    expect(isSupportedTreeFile('Letter.ODT')).toBe(true)
    expect(literal(main, 'OPEN_DIALOG_EXTENSIONS')).toContain("'odt'")
    expect(literal(home, 'OPEN_LOCAL_EXTENSIONS')).toContain('.odt')
    // the Word tile, since the Word tab opens it
    expect(literal(home, 'FILE_ICONS')).toContain('odt: iconDocx')
  })

  it('routes .odt to the Word tab in the single open router', () => {
    const route = fnSource('routeDocumentPath')
    expect(route).toContain('if (DOCX_RE.test(filePath) || ODT_RE.test(filePath)) {')
    expect(route.indexOf('ODT_RE')).toBeLessThan(route.indexOf('openDocsTab'))
  })

  it('gives the home open dialog its own ODT filter', () => {
    expect(main).toContain("{ name: tm('filterOdt'), extensions: ['odt'] },")
  })
})

describe('ODT export menus', () => {
  it('puts "Export as ODT" right after "Export as Word" in the Markdown menu', () => {
    const menu = fnSource('buildMarkdownMenu')
    const docx = menu.indexOf("sendMarkdownExportRequest(tab.webContents, 'docx')")
    const odt = menu.indexOf("sendMarkdownExportRequest(tab.webContents, 'odt')")
    expect(docx).toBeGreaterThan(0)
    expect(odt).toBeGreaterThan(docx)
    expect(menu.slice(docx, odt)).toContain("label: tm('menuExportOdt')")
    expect(menu.slice(docx, odt)).not.toContain("'pdf'")
  })

  it('puts "Export as ODT" right after "Export as Word" in the HTML menu', () => {
    const menu = fnSource('buildHtmlMenu')
    const docx = menu.indexOf("sendHtmlExportRequest(tab.webContents, 'docx')")
    const odt = menu.indexOf("sendHtmlExportRequest(tab.webContents, 'odt')")
    expect(docx).toBeGreaterThan(0)
    expect(odt).toBeGreaterThan(docx)
    expect(menu.slice(docx, odt)).toContain("label: tm('menuExportOdt')")
    expect(menu.slice(docx, odt)).not.toContain("'pdf'")
  })

  it('names the item and the dialog filter in every language', () => {
    expect(LANGS).toHaveLength(21)
    const english = localeBlock('en')
    const englishOdt = english.match(/menuExportOdt: '([^']*)'/)?.[1]
    expect(englishOdt).toBe('Export as ODT…')
    expect(english).toContain("filterOdt: 'OpenDocument Text'")
    for (const lang of LANGS) {
      const block = localeBlock(lang)
      const label = block.match(/menuExportOdt: '([^']*)'/)?.[1]
      expect(label, `${lang} menuExportOdt`).toMatch(/ODT/)
      expect(block, `${lang} filterOdt`).toMatch(/filterOdt: '[^']*OpenDocument[^']*'/)
      if (lang !== 'en') expect(label, `${lang} copies the English label`).not.toBe(englishOdt)
    }
  })
})
