import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Fixed by reading the source (index.ts and the editor mains need a running
 * Electron): spec 8.2 and 9's entries are in all seven editors' File menus,
 * the records follow every save hook of an editor a hand-off or conversion
 * opens into, every in-app rename and move, and nothing is written anywhere
 * but the records file.
 */

const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const index = src('../src/main/index.ts')

/** the body of `function name(` up to the next top-level function */
function body(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no function ${name}`)
  const end = text.indexOf('\nfunction ', start + 1)
  const exportEnd = text.indexOf('\nexport function ', start + 1)
  const stops = [end, exportEnd].filter((i) => i > 0)
  return text.slice(start, stops.length ? Math.min(...stops) : undefined)
}

describe('the File menus', () => {
  it.each([
    ['buildPdfMenu', 'pdf'],
    ['buildMarkdownMenu', 'markdown'],
    ['buildHtmlMenu', 'html'],
    ['buildMindmapMenu', 'mindmap'],
  ])('%s lists the entries for its own kind', (builder, kind) => {
    const text = body(index, builder)
    expect(text).toContain(`...documentLinkFileMenuItems('${kind}'),`)
    // inside the File menu: before the Edit menu starts
    expect(text.indexOf('documentLinkFileMenuItems')).toBeLessThan(text.indexOf("tm('menuClose')"))
  })

  it.each([
    ['../../docs/src/main/docs-main.ts', 'setDocsDocumentLinkMenuItems', 'buildDocsMenu', 'docs'],
    [
      '../../sheets/src/main/sheets-main.ts',
      'setSheetsDocumentLinkMenuItems',
      'installApplicationMenu',
      'sheets',
    ],
    [
      '../../slides/src/main/slides-main.ts',
      'setSlidesDocumentLinkMenuItems',
      'buildSlidesMenu',
      'slides',
    ],
  ])('%s asks the shell for them at every build', (path, setter, builder, kind) => {
    const text = src(path)
    expect(text).toContain(`export function ${setter}(`)
    const build = body(text, builder)
    expect(build).toContain('...(documentLinkMenuItems?.() ?? []),')
    // in the File menu, next to the shell's other File-menu items, before Save
    const at = build.indexOf('documentLinkMenuItems?.()')
    expect(at).toBeGreaterThan(build.indexOf("tm('menuFile')"))
    expect(at).toBeGreaterThan(build.indexOf('...extraFileMenuItems]'))
    expect(at).toBeLessThan(build.indexOf("tm('menuSave')"))
    expect(index).toContain(`${setter}(() => documentLinkFileMenuItems('${kind}'))`)
  })

  it('installs the editors’ entries once at start', () => {
    expect(index.match(/installDocumentLinkMenuItems\(\)/g)).toHaveLength(2)
  })

  it('wires the mind map toolbar button to the same make window', () => {
    expect(index).toContain('setMindmapMakeFromDocumentHook((wc) => makeFromDocument(wc))')
    const shell = src('../src/main/document-links-shell.ts')
    expect(shell).toMatch(/openGenerateWindowForDocument\(\{/)
  })

  it('refreshes the menu when the tabs or the records change', () => {
    expect(index).toContain(
      'publishOpenDocumentsIfOwner([...manager.openFilePaths(), ...detachedFilePaths()])\n      refreshDocumentLinkMenu()',
    )
    expect(src('../src/main/document-links-shell.ts')).toContain(
      'links.onChange(() => refreshDocumentLinkMenu())',
    )
  })
})

describe('the records follow the app', () => {
  it.each(['Markdown', 'Html', 'Mindmap'])('the %s save hook notes the first save', (name) => {
    const at = index.indexOf(`set${name}FileSavedHook((wc, path) => {`)
    const hook = index.slice(at, index.indexOf('\n  })', at))
    expect(hook).toContain('noteDocumentSaved(wc, path)')
  })

  it('the slides hook, which also fires on open, counts only a save happening now', () => {
    const at = index.indexOf('setSlidesOpenedHook((wc, path) => {')
    const hook = index.slice(at, index.indexOf('\n  })', at))
    expect(hook).toContain('noteDocumentSaved(wc, path, { mayBeOpen: true })')
  })

  it('renames and moves inside the app re-key the records', () => {
    expect(body(index, 'afterFileMoved')).toContain('documentLinkFileMoved(oldPath, newPath)')
    expect(body(index, 'trackedFilesUnder')).toContain('...documentLinkPaths(),')
    const pdf = index.slice(
      index.indexOf('setPdfRenamedHook('),
      index.indexOf('setPdfRenamedHook(') + 400,
    )
    expect(pdf).toContain('documentLinkFileMoved(oldPath, newPath)')
  })

  it('keeps the records in the app data folder and writes nothing else', () => {
    const shell = src('../src/main/document-links-shell.ts')
    expect(shell).toContain('join(next.userDataPath(), DOCUMENT_LINKS_FILE)')
    expect(index).toContain("userDataPath: () => app.getPath('userData')")
    const core = src('../src/main/document-links.ts')
    expect(core).not.toMatch(/from 'electron'/)
    expect(core).not.toMatch(/\bwriteFile(Sync)?\(|\brenameSync\(|\bunlink/)
    expect(core).toContain('save: (file) => writeJsonAtomic(filePath, file)')
    expect(core).toContain("export const DOCUMENT_LINKS_FILE = 'document-links.json'")
  })
})

describe('the strings', () => {
  const LOCALES = [
    'zh',
    'en',
    'vi',
    'ja',
    'ko',
    'fr',
    'de',
    'es',
    'th',
    'id',
    'ru',
    'ar',
    'pt',
    'it',
    'pl',
    'cs',
    'nl',
    'ms',
    'he',
    'hi',
    "'zh-TW'",
  ]
  const KEYS = ['menuMakeFromDocument', 'menuDocumentSources', 'menuDerivedDocuments']
  function block(locale: string): string {
    const start = index.search(new RegExp(`\\n {2}${locale}: \\{`))
    const rest = index.slice(start + 1)
    const end = rest.search(/\n {2}\S+: \{/)
    return end < 0 ? rest : rest.slice(0, end)
  }
  const valueIn = (locale: string, key: string) =>
    block(locale).match(new RegExp(`\\n {4}${key}: '([^']*)'`))?.[1]

  it('are in all 21 locales and translated', () => {
    for (const key of KEYS) {
      const english = valueIn('en', key)
      for (const locale of LOCALES) {
        const value = valueIn(locale, key)
        expect(value, `${key} in ${locale}`).toBeTruthy()
        if (locale !== 'en') expect(value, `${key} in ${locale}`).not.toBe(english)
      }
    }
  })

  it('read in Korean and English as written', () => {
    expect(valueIn('ko', 'menuMakeFromDocument')).toBe('이 문서로 다른 문서 만들기')
    expect(valueIn('ko', 'menuDocumentSources')).toBe('자료 보기')
    expect(valueIn('ko', 'menuDerivedDocuments')).toBe('이 문서로 만든 문서')
    expect(valueIn('en', 'menuMakeFromDocument')).toBe('Make Another Document from This')
    expect(valueIn('en', 'menuDocumentSources')).toBe('View Sources')
    expect(valueIn('en', 'menuDerivedDocuments')).toBe('Documents Made from This')
  })
})
