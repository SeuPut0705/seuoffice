import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
// Through the package's front door on purpose: loading the index is what must
// switch the default theme on.
import {
  applySheetTheme,
  buildThemeLook,
  createThemeRecogniser,
  createXmindDocument,
  createXmindDocumentFromSheets,
  DEFAULT_THEME_ID,
  newSheet,
  parseThemeId,
  recogniseSheetTheme,
  recogniseTheme,
  SHIPPED_THEME_TABLES,
  THEME_BANDS,
  THEME_IDS,
  themeLook,
  themePropertiesOf,
  themeTable,
  WRITTEN_THEME_TABLES,
  writeSheetTheme,
  writtenThemeProperties,
  type ThemeBandColors,
  type ThemeId,
  type ThemeProperties,
  type XmindSheet,
} from '../src/index'
import { contrastRatio } from '../src/theme-color'
import { buildMapFile, CONTENT, openOk, sampleSheets, text, unzip } from './helpers'

/** WCAG AA for running text. */
const READABLE = 4.5
/**
 * A block's main topics are filled with their own branch colour, and the file
 * can give that level one text colour only. On the light grounds no single
 * colour reaches 4.5:1 on all four accents (they differ in lightness by design),
 * so the floor there is WCAG's level for large bold text, which these are.
 */
const MIN_CONTRAST_ON_BRANCH_FILL = 3

function filledFromBranch(id: ThemeId, level: string): boolean {
  return id.startsWith('block/') && !id.endsWith('/dark') && level === 'mainTopic'
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const LEVELS = ['map', 'centralTopic', 'mainTopic', 'subTopic']
const TOPIC_PROPERTIES = [
  'fo:font-size',
  'fo:font-weight',
  'fo:color',
  'svg:fill',
  'fill-pattern',
  'line-width',
  'line-color',
  'border-line-color',
  'border-line-width',
  'shape-class',
  'line-class',
]

/**
 * The tables written today, pinned. When this value has to change, the app
 * writes something else for at least one theme than it did before:
 *  - if the old values never shipped, put the new digest here;
 *  - if they did, first copy the old table of every affected theme into
 *    `SHIPPED_THEME_TABLES` (src/theme-table.ts), then put the new digest here.
 */
const WRITTEN_TABLES_DIGEST = '1871ad518bd5ca34e8e7726d73a738a08c898d44e7ac82588c02d0704e0e22be'

/**
 * The tables the 0.12 releases wrote, pinned the same way. They are worked
 * out from today's tables and the sizes of 0.12, so a colour or a rule that
 * moves would move them too: when this fails, write the tables out by hand
 * instead of deriving them (see `SHIPPED_THEME_TABLES`).
 */
const SHIPPED_TABLES_DIGEST = '2418608d216f51cdf5cf45cd9f42eb184fc39832036a064b75d08d12b3ebf307'

/** A theme from some other program: hand-written, every value invented here. */
function foreignTheme(): Record<string, unknown> {
  return {
    map: {
      id: 'foreign-map',
      properties: {
        'svg:fill': '#101820',
        'multi-line-colors': '#aa3355 #33aa55 #5533aa',
        'color-list': '#f0f0e8 #aa3355 #33aa55 #5533aa #c9a227 #101820',
        'line-tapered': 'none',
      },
    },
    centralTopic: {
      id: 'foreign-central',
      properties: {
        'fo:font-family': 'Some Family',
        'fo:font-size': '30pt',
        'fo:font-weight': '500',
        'fo:color': 'inherited',
        'svg:fill': '#c9a227',
        'fill-pattern': 'solid',
        'line-width': '3pt',
        'border-line-width': '0',
        'shape-class': 'org.xmind.topicShape.roundedRect',
        'line-class': 'org.xmind.branchConnection.curve',
      },
    },
    mainTopic: {
      id: 'foreign-main',
      properties: { 'fo:font-size': '18pt', 'svg:fill': 'inherited', 'fill-pattern': 'solid' },
    },
    subTopic: { id: 'foreign-sub', properties: { 'fo:font-size': '13pt', 'fill-pattern': 'none' } },
    floatingTopic: { id: 'foreign-floating', properties: { 'svg:fill': '#33aa55' } },
    skeletonThemeId: 'made-up-skeleton',
    colorThemeId: 'Made-Up-#101820-KIND',
  }
}

/** A table the way a file holds it: every level wrapped with an id. */
function asFileHoldsIt(properties: ThemeProperties): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, level], index) => [
      name,
      { id: `level-${index}`, properties: { ...level } },
    ]),
  )
}

function sheetWith(theme: unknown): XmindSheet {
  return {
    id: 'sheet',
    class: 'sheet',
    rootTopic: { id: 'root', title: 'Root' },
    title: 'S',
    theme,
  }
}

/** The text of `content.json` in saved bytes. */
async function contentOf(bytes: Uint8Array): Promise<string> {
  return text((await unzip(bytes)).get(CONTENT)!)
}

describe('writing a theme', () => {
  it('writes all 96 themes, and each is recognised as itself', () => {
    for (const id of THEME_IDS) {
      const sheet = sheetWith(undefined)
      writeSheetTheme(sheet, id)
      expect(recogniseSheetTheme(sheet), id).toBe(id)
    }
  })

  it('recognises all 96 again after a save and a fresh open', async () => {
    const sheets = THEME_IDS.map((id) => {
      const sheet = newSheet({ title: id, rootTitle: 'Root' })
      writeSheetTheme(sheet, id)
      return sheet
    })
    const saved = await (await createXmindDocumentFromSheets(sheets)).save()
    const reopened = await openOk(saved)
    expect(reopened.sheets.map(recogniseSheetTheme)).toEqual(THEME_IDS)
    expect(reopened.changed).toBe(false)
  })

  it('gives no two themes the same table', () => {
    expect(WRITTEN_THEME_TABLES.map((entry) => entry.themeId)).toEqual(THEME_IDS)
    const tables = WRITTEN_THEME_TABLES.map((entry) => JSON.stringify(entry.properties))
    expect(new Set(tables).size).toBe(96)
  })

  it('writes one property table per level, each under a fresh id', () => {
    const first = themeTable('capsule/slate/tint')
    const second = themeTable('capsule/slate/tint')
    expect(Object.keys(first)).toEqual(LEVELS)
    const ids = [...Object.values(first), ...Object.values(second)].map((level) => level.id)
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(8)
    for (const name of LEVELS) {
      expect(Object.keys(first[name]!)).toEqual(['id', 'properties'])
      expect(first[name]!.properties).toEqual(second[name]!.properties)
      expect(first[name]!.properties).not.toBe(second[name]!.properties)
    }
  })

  it.each(THEME_IDS)('%s is written in the properties the format defines', (id) => {
    const look = themeLook(id)
    const table = writtenThemeProperties(id)
    expect(Object.keys(table)).toEqual(LEVELS)
    expect(table.map).toEqual({
      'svg:fill': look.ground,
      'multi-line-colors': look.branches.map((branch) => branch.color).join(' '),
      'color-list': THEME_BANDS[look.band].join(' '),
      'line-tapered': 'none',
    })
    for (const name of LEVELS.slice(1)) {
      const level = table[name]!
      expect(Object.keys(level)).toEqual(TOPIC_PROPERTIES)
      // whole numbers only, in the units the format uses
      expect(level['fo:font-size']).toMatch(/^\d+pt$/)
      expect(level['fo:font-weight']).toMatch(/^[1-9]00$/)
      expect(level['line-width']).toMatch(/^\d+pt$/)
      expect(level['border-line-width']).toMatch(/^\d+pt$/)
      expect(level['fill-pattern']).toMatch(/^(?:solid|none)$/)
      for (const color of ['svg:fill', 'line-color', 'border-line-color']) {
        expect(level[color]).toMatch(/^(?:#[0-9a-f]{6}|inherited)$/)
      }
      // The text colour is always spelled out: left out, a program falls back
      // to fixed colours of its own that need not read on these fills.
      expect(level['fo:color']).toMatch(/^#[0-9a-f]{6}$/)
    }
    // No font name, no pointer at the app's own colours, and no theme name of
    // any program: only the four levels above.
    expect(JSON.stringify(table)).not.toMatch(/font-family|fontFamily|var\(|ThemeId/)
  })

  it.each(THEME_IDS)('%s writes text that reads on what the file puts under it', (id) => {
    const table = writtenThemeProperties(id)
    const ground = table.map!['svg:fill']!
    const branches = table.map!['multi-line-colors']!.split(' ')
    for (const name of LEVELS.slice(1)) {
      const level = table[name]!
      const text = level['fo:color']!
      // No fill: the text is on the map. A fill taken from the branch: on any
      // of the branch colours. Otherwise on the fill as written.
      const surfaces =
        level['fill-pattern'] === 'none'
          ? [ground]
          : level['svg:fill'] === 'inherited'
            ? branches
            : [level['svg:fill']!]
      for (const surface of surfaces) {
        const wanted = filledFromBranch(id, name) ? MIN_CONTRAST_ON_BRANCH_FILL : READABLE
        expect(
          contrastRatio(text, surface),
          `${name}: ${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(wanted)
      }
    }
  })

  it('writes the text colours of the dark harbor blocks that read in the other program', () => {
    const table = writtenThemeProperties('block/harbor/dark')
    expect(table.centralTopic!['svg:fill']).toBe('#f2f7fa')
    expect(contrastRatio(table.centralTopic!['fo:color']!, '#f2f7fa')).toBeGreaterThanOrEqual(
      READABLE,
    )
    expect(table.subTopic!['svg:fill']).toBe('#243749')
    expect(contrastRatio(table.subTopic!['fo:color']!, '#243749')).toBeGreaterThanOrEqual(READABLE)
  })

  it('carries the three levels over as whole numbers that still shrink', () => {
    const { centralTopic, mainTopic, subTopic } = writtenThemeProperties('pill/paper/light')
    expect(centralTopic).toMatchObject({ 'fo:font-size': '18pt', 'fo:font-weight': '700' })
    expect(mainTopic).toMatchObject({ 'fo:font-size': '14pt', 'fo:font-weight': '600' })
    expect(subTopic).toMatchObject({ 'fo:font-size': '13pt', 'fo:font-weight': '400' })
    // the centre's branch lines, then the thinner ones below
    expect(centralTopic!['line-width']).toBe('2pt')
    expect(mainTopic!['line-width']).toBe('1pt')
  })

  it('maps the skeletons the way the format can show them', () => {
    const main = (id: ThemeId): Record<string, string> => writtenThemeProperties(id).mainTopic!
    const sub = (id: ThemeId): Record<string, string> => writtenThemeProperties(id).subTopic!
    const rounded = 'org.xmind.topicShape.roundedRect'
    const curve = 'org.xmind.branchConnection.curve'

    // pill: a rounded rectangle with a quiet fill
    expect(main('pill/clay/light')).toMatchObject({ 'shape-class': rounded, 'line-class': curve })
    expect(main('pill/clay/light')).toMatchObject({
      'fill-pattern': 'solid',
      'border-line-width': '0pt',
    })
    expect(main('pill/clay/light')['svg:fill']).toMatch(/^#[0-9a-f]{6}$/)
    expect(sub('pill/clay/light')['fill-pattern']).toBe('none')
    // capsule: a rounded rectangle with an outline and no fill
    expect(main('capsule/clay/light')).toMatchObject({
      'shape-class': rounded,
      'line-class': curve,
    })
    expect(main('capsule/clay/light')).toMatchObject({
      'fill-pattern': 'none',
      'border-line-width': '1pt',
    })
    // block: a rounded rectangle filled with its branch colour, rounded elbows
    expect(main('block/clay/light')).toMatchObject({
      'shape-class': rounded,
      'svg:fill': 'inherited',
      'fill-pattern': 'solid',
      'line-class': 'org.xmind.branchConnection.roundedElbow',
    })
    expect(sub('block/clay/light')).toMatchObject({
      'shape-class': rounded,
      'fill-pattern': 'solid',
    })
    // line: the underline shape, on every level below the centre
    for (const level of [main('line/clay/light'), sub('line/clay/light')]) {
      expect(level).toMatchObject({
        'shape-class': 'org.xmind.topicShape.underline',
        'fill-pattern': 'none',
        'line-class': curve,
      })
    }
    expect(main('line/clay/light')['border-line-width']).toBe('2pt')
    expect(sub('line/clay/light')['border-line-width']).toBe('1pt')
  })

  it('pins what is written today (read the note on the digest when this fails)', () => {
    const digest = createHash('sha256').update(JSON.stringify(WRITTEN_THEME_TABLES)).digest('hex')
    expect(digest).toBe(WRITTEN_TABLES_DIGEST)
  })

  it('pins the tables older releases wrote (read the note on the digest when this fails)', () => {
    const digest = createHash('sha256').update(JSON.stringify(SHIPPED_THEME_TABLES)).digest('hex')
    expect(SHIPPED_THEME_TABLES).toHaveLength(THEME_IDS.length)
    expect(digest).toBe(SHIPPED_TABLES_DIGEST)
  })
})

describe('recognising a theme', () => {
  const id: ThemeId = 'block/plum/dark'

  it('does not compare the level ids or the order of keys', () => {
    const table = themeTable(id)
    for (const level of Object.values(table)) level.id = 'another id altogether'
    expect(recogniseTheme(table)).toBe(id)

    const shuffled = Object.fromEntries(
      Object.entries(themeTable(id))
        .reverse()
        .map(([name, level]) => [
          name,
          { properties: Object.fromEntries(Object.entries(level.properties).reverse()) },
        ]),
    )
    expect(Object.keys(shuffled)).toEqual([...LEVELS].reverse())
    expect(recogniseTheme(shuffled)).toBe(id)
  })

  it('does not recognise a theme from elsewhere', () => {
    expect(recogniseTheme(foreignTheme())).toBeNull()
    expect(recogniseSheetTheme(sampleSheets()[0] as XmindSheet)).toBeNull()
    for (const nothing of [undefined, null, {}, [], 'pill/paper/light', 7, [themeTable(id)]]) {
      expect(recogniseTheme(nothing), JSON.stringify(nothing)).toBeNull()
    }
    expect(recogniseSheetTheme({ rootTopic: { id: 'root' } })).toBeNull()
  })

  it.each<[string, (table: Record<string, any>) => void]>([
    ['one colour changed', (t) => (t.map.properties['svg:fill'] = '#123456')],
    ['one size changed', (t) => (t.mainTopic.properties['fo:font-size'] = '17pt')],
    ['a value in other letters', (t) => (t.subTopic.properties['fill-pattern'] = 'SOLID')],
    ['a property removed', (t) => delete t.centralTopic.properties['line-width']],
    ['a property added', (t) => (t.centralTopic.properties['fo:font-family'] = 'Some Family')],
    ['a property that is not text', (t) => (t.subTopic.properties['line-width'] = 1)],
    ['a level removed', (t) => delete t.subTopic],
    ['a level added', (t) => (t.level3 = { id: 'x', properties: {} })],
    ['a name beside the levels', (t) => (t.colorThemeId = 'Made-Up-#101820-KIND')],
    ['a key beside the properties', (t) => (t.map.note = 'edited')],
    ['a level without properties', (t) => (t.map = { id: 'x' })],
    ['a level that is a list', (t) => (t.map = [t.map])],
  ])('does not recognise one of ours with %s', (_what, alter) => {
    const table = themeTable(id)
    expect(recogniseTheme(table)).toBe(id)
    alter(table)
    expect(recogniseTheme(table)).toBeNull()
  })

  it('refuses two themes that would share a table', () => {
    const properties = writtenThemeProperties(id)
    expect(() =>
      createThemeRecogniser([
        { themeId: id, properties },
        { themeId: 'pill/plum/dark', properties },
      ]),
    ).toThrow(/xmind:.*same table/)
    // An old table may not be what another theme writes today either.
    expect(() =>
      createThemeRecogniser(WRITTEN_THEME_TABLES, [{ themeId: 'pill/plum/dark', properties }]),
    ).toThrow(/xmind:/)
  })
})

describe('a theme whose values changed after a release', () => {
  const id: ThemeId = 'pill/paper/light'
  // What an earlier release would have written: the same theme, when one
  // accent of its band still had another (invented) value.
  const earlierBand = THEME_BANDS.paper.map((color, index) =>
    index === 2 ? '#2f6f5f' : color,
  ) as unknown as ThemeBandColors
  const earlier = themePropertiesOf(buildThemeLook(parseThemeId(id)!, earlierBand))

  it('remembers the sizes of 0.12, so a file from it opens as the theme its user picked', async () => {
    expect(SHIPPED_THEME_TABLES).toHaveLength(96)
    const shipped = SHIPPED_THEME_TABLES.find((entry) => entry.themeId === id)!.properties
    expect(shipped.centralTopic!['fo:font-size']).toBe('21pt')
    expect(shipped.mainTopic!['fo:font-size']).toBe('15pt')
    expect(shipped.subTopic!['fo:font-size']).toBe('14pt')
    expect(JSON.stringify(shipped)).not.toBe(JSON.stringify(writtenThemeProperties(id)))
    expect(recogniseTheme(asFileHoldsIt(shipped))).toBe(id)

    // A file of 0.12 opens as that theme, draws with today's look and keeps its own table.
    const theme = asFileHoldsIt(shipped)
    const bytes = await buildMapFile({ content: [{ ...sheetWith(theme), id: 'sheet-1' }] })
    const document = await openOk(bytes)
    expect(recogniseSheetTheme(document.sheets[0]!)).toBe(id)
    expect(document.changed).toBe(false)
    expect(await document.save()).toEqual(bytes)
  })

  it('still recognises the earlier table as the same theme', () => {
    expect(JSON.stringify(earlier)).not.toBe(JSON.stringify(writtenThemeProperties(id)))
    expect(recogniseTheme(asFileHoldsIt(earlier))).toBeNull()
    const recognise = createThemeRecogniser(WRITTEN_THEME_TABLES, [
      { themeId: id, properties: earlier },
    ])
    expect(recognise(asFileHoldsIt(earlier))).toBe(id)
    // What is written today is recognised as before, for every theme.
    for (const themeId of THEME_IDS) expect(recognise(themeTable(themeId))).toBe(themeId)
    // A changed copy of the earlier table is no more ours than any other.
    const altered = asFileHoldsIt(earlier) as Record<string, any>
    altered.map.properties['svg:fill'] = '#123456'
    expect(recognise(altered)).toBeNull()
  })

  it('leaves the earlier properties in the file until a theme is picked again', async () => {
    const recognise = createThemeRecogniser(WRITTEN_THEME_TABLES, [
      { themeId: id, properties: earlier },
    ])
    const theme = asFileHoldsIt(earlier)
    const sheets = [{ ...sheetWith(theme), id: 'sheet-1' }]
    const bytes = await buildMapFile({ content: sheets })
    const document = await openOk(bytes)

    expect(recognise(document.sheets[0]!.theme)).toBe(id)
    expect(document.changed).toBe(false)
    expect(await document.save()).toEqual(bytes)

    // An edit elsewhere is saved; the theme goes out letter for letter.
    document.sheets[0]!.rootTopic.title = 'Renamed'
    document.markChanged()
    const written = await contentOf(await document.save())
    expect(written).toContain('"title":"Renamed"')
    expect(written).toContain(`"theme":${JSON.stringify(theme)}`)

    // Picking the theme again writes it with today's values.
    applySheetTheme(document, 0, id)
    expect(recogniseSheetTheme(document.sheets[0]!)).toBe(id)
    expect(await contentOf(await document.save())).toContain(THEME_BANDS.paper[2])
  })
})

describe('a file whose theme nobody chose', () => {
  it('is not marked changed by being recognised', async () => {
    const ours = sheetWith(themeTable('line/signal/light'))
    const bytes = await buildMapFile({ content: [ours, ...sampleSheets()] })
    const document = await openOk(bytes)
    const before = JSON.stringify(document.sheets)

    expect(document.sheets.map(recogniseSheetTheme)).toEqual(['line/signal/light', null])
    expect(JSON.stringify(document.sheets)).toBe(before)
    expect(document.changed).toBe(false)
    expect(await document.save()).toEqual(bytes)
  })

  it.each<[string, unknown]>([
    ['a theme from elsewhere', foreignTheme()],
    ['an empty theme', {}],
    ['one of ours', themeTable('capsule/moss/tint')],
  ])('keeps %s byte for byte through a save of something else', async (_what, theme) => {
    const document = await openOk(await buildMapFile({ content: [sheetWith(theme)] }))
    recogniseSheetTheme(document.sheets[0]!)
    document.sheets[0]!.rootTopic.children = { attached: [{ id: 'added', title: 'Added' }] }
    document.markChanged()

    const written = await contentOf(await document.save())
    expect(written).toContain('"title":"Added"')
    expect(written.endsWith(`,"theme":${JSON.stringify(theme)}}]`)).toBe(true)
  })

  it('keeps a sheet without a theme without one', async () => {
    const { theme: _none, ...bare } = sheetWith(undefined)
    const document = await openOk(await buildMapFile({ content: [bare] }))
    expect(recogniseSheetTheme(document.sheets[0]!)).toBeNull()
    document.sheets[0]!.title = 'Renamed'
    document.markChanged()
    expect(await contentOf(await document.save())).not.toContain('"theme"')
  })
})

describe('picking a theme', () => {
  it('replaces the theme of that sheet only and marks the document changed', async () => {
    const other = { ...sheetWith(foreignTheme()), id: 'sheet-2' }
    const document = await openOk(
      await buildMapFile({ content: [sheetWith(foreignTheme()), other] }),
    )
    expect(document.changed).toBe(false)

    const marked = vi.spyOn(document, 'markChanged')
    applySheetTheme(document, 0, 'block/harbor/dark')
    expect(marked).toHaveBeenCalledTimes(1)
    expect(document.changed).toBe(true)
    expect(Object.keys(document.sheets[0]!.theme as object)).toEqual(LEVELS)
    expect(document.sheets[1]!.theme).toEqual(foreignTheme())

    const reopened = await openOk(await document.save())
    expect(reopened.sheets.map(recogniseSheetTheme)).toEqual(['block/harbor/dark', null])
  })

  it('turns down a sheet or a theme that does not exist', async () => {
    const document = await createXmindDocument({ sheetTitle: 'S', rootTitle: 'R' })
    const before = JSON.stringify(document.sheets)
    expect(() => applySheetTheme(document, 1, DEFAULT_THEME_ID)).toThrow(/xmind:/)
    expect(() => applySheetTheme(document, 0, 'pill/paper/dusk' as ThemeId)).toThrow(/xmind:/)
    expect(JSON.stringify(document.sheets)).toBe(before)
    expect(document.changed).toBe(false)
  })
})

describe('the default theme', () => {
  it('dresses a new file, which is recognised as it', async () => {
    const document = await createXmindDocument({ sheetTitle: 'Sheet 1', rootTitle: 'Central' })
    const sheet = document.sheets[0]!
    expect(recogniseSheetTheme(sheet)).toBe('pill/paper/light')
    expect(recogniseSheetTheme(sheet)).toBe(DEFAULT_THEME_ID)
    expect(Object.keys(sheet)).toEqual(['id', 'class', 'rootTopic', 'title', 'theme'])
    expect(document.changed).toBe(false)

    const bytes = await document.save()
    const reopened = await openOk(bytes)
    expect(recogniseSheetTheme(reopened.sheets[0]!)).toBe(DEFAULT_THEME_ID)
    expect(await reopened.save()).toEqual(bytes)
  })

  it('dresses a new sheet the same way', () => {
    const sheet = newSheet({ title: 'Later sheet', rootTitle: 'Root' })
    expect(recogniseSheetTheme(sheet)).toBe(DEFAULT_THEME_ID)
    expect(Object.keys(sheet).at(-1)).toBe('theme')
    // Two sheets never share a table object, or an edit to one would reach the other.
    expect(newSheet({ title: 'Another', rootTitle: 'Root' }).theme).not.toBe(sheet.theme)
  })

  it('writes no font name anywhere in a new file', async () => {
    const bytes = await (await createXmindDocument({ sheetTitle: 'S', rootTitle: 'R' })).save()
    for (const [name, data] of await unzip(bytes)) {
      expect(text(data), name).not.toMatch(/font-family|fontFamily/)
    }
  })
})
