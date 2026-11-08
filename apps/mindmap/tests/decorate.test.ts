/**
 * The look on a map that is on screen, with the real drawing library in jsdom:
 * themes are written only when picked and come back the same, a file's style
 * values and pictures reach the page only in the forms the editor allows, and
 * the file keeps every value it had.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THEME_ID,
  openXmind,
  recogniseSheetTheme,
  THEME_IDS,
  themeLook,
  writeSheetTheme,
  type ThemeId,
  type XmindDocument,
  type XmindSheet,
} from '@genoffice/xmind-engine'
import { MapController, type MapHost, type MapStrings } from '../src/renderer/map/controller'
import { DocumentSession } from '../src/renderer/document/session'
import { mapStrings } from '../src/renderer/i18n/map-strings'
import { branchVars, containerVars } from '../src/renderer/map/look'
import {
  copyOf,
  documentOf,
  documentWithEntries,
  IDS,
  plainSheet,
  richSheet,
  TINY_PNG,
  topic,
} from './helpers/fixtures'
import { until } from './helpers/wait'

const STRINGS: MapStrings = mapStrings('ko')

const mounted: MapController[] = []
afterEach(() => {
  mounted.splice(0).forEach((controller) => controller.destroy())
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})

function show(doc: XmindDocument, sheetIndex = 0) {
  const session = new DocumentSession(doc)
  const el = document.createElement('div')
  document.body.appendChild(el)
  const host: MapHost = {
    confirmDelete: vi.fn(async () => true),
    openLink: vi.fn(),
    onRequest: vi.fn(),
    onStateChange: vi.fn(),
  }
  const key = session.tabs()[sheetIndex]!.key
  const controller = new MapController({ el, session, sheetKey: key, strings: STRINGS, host })
  mounted.push(controller)
  const container = el.querySelector<HTMLElement>('.map-container')!
  return { doc, session, el, key, controller, mind: controller.mind, container, host }
}

async function mount(...sheets: XmindSheet[]) {
  return show(await documentOf(...sheets))
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function topicEl(el: HTMLElement, id: string): HTMLElement {
  const found = el.querySelector<HTMLElement>(`[data-nodeid="me${id}"]`)
  if (!found) throw new Error(`topic ${id} is not drawn`)
  return found
}

/** Every inline custom property of an element, by name. */
function customProperties(element: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {}
  for (let at = 0; at < element.style.length; at++) {
    const name = element.style.item(at)
    if (name.startsWith('--')) out[name] = element.style.getPropertyValue(name)
  }
  return out
}

/** What the map is drawn with: the properties on the container and on each main branch, and each topic's own style. */
function drawnColours(el: HTMLElement): string {
  const container = el.querySelector<HTMLElement>('.map-container')!
  return JSON.stringify({
    container: customProperties(container),
    branches: [...el.querySelectorAll<HTMLElement>('me-main > me-wrapper')].map(customProperties),
    lines: [...el.querySelectorAll('svg.lines path')].map((path) => path.getAttribute('stroke')),
    topics: [...el.querySelectorAll<HTMLElement>('me-tpc')].map((each) =>
      each.getAttribute('style'),
    ),
    markers: [...el.querySelectorAll('.mm-marker')].map((glyph) => glyph.outerHTML),
  })
}

const ID = {
  root: 'aaaaaaaa-0000-4000-8000-000000000001',
  one: 'aaaaaaaa-0000-4000-8000-000000000002',
  two: 'aaaaaaaa-0000-4000-8000-000000000003',
  three: 'aaaaaaaa-0000-4000-8000-000000000004',
  four: 'aaaaaaaa-0000-4000-8000-000000000005',
  five: 'aaaaaaaa-0000-4000-8000-000000000006',
  sub: 'aaaaaaaa-0000-4000-8000-000000000007',
} as const

const style = (properties: Record<string, string>) => ({
  style: { id: 'made-up-style', properties },
})

function sheetOf(...mains: ReturnType<typeof topic>[]): XmindSheet {
  return {
    id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
    class: 'sheet',
    rootTopic: topic(ID.root, 'Centre', {}, mains),
    title: 'Sheet',
  }
}

describe('the theme of a sheet', () => {
  it('a map with no theme is drawn with the default look, and drawing it writes nothing', async () => {
    const { controller, container, doc, session } = await mount(plainSheet())
    const original = await session.produceBytes()
    expect(controller.themeId).toBe(DEFAULT_THEME_ID)
    expect(controller.themeWritten).toBe(false)
    expect(container.dataset.mmTheme).toBe(DEFAULT_THEME_ID)
    expect(customProperties(container)).toMatchObject(containerVars(themeLook(DEFAULT_THEME_ID)))
    controller.flush()
    expect(doc.changed).toBe(false)
    expect(doc.sheets[0]!.theme).toBeUndefined()
    expect(await session.produceBytes()).toEqual(original)
  })

  it('a theme this app did not write is left in the file and the sheet is drawn with the default look', async () => {
    const { controller, container, doc, session } = await mount(richSheet())
    const theme = copyOf(doc.sheets[0]!.theme)
    expect(session.hasUnknownTheme()).toBe(true)
    expect(controller.themeWritten).toBe(false)
    expect(container.dataset.mmTheme).toBe(DEFAULT_THEME_ID)
    controller.flush()
    expect(doc.changed).toBe(false)
    expect(doc.sheets[0]!.theme).toEqual(theme)
  })

  it('picking each of the 96 themes writes it, and the file opened again is drawn with the same look', async () => {
    const { controller, container, doc, session } = await mount(plainSheet())
    for (const id of THEME_IDS) {
      const changed = controller.setTheme(id)
      // the map with no theme is drawn with the default look, but picking that look still writes it
      expect(changed, id).toBe(true)
      expect(recogniseSheetTheme(doc.sheets[0]!), id).toBe(id)
      expect(controller.themeId, id).toBe(id)
      expect(controller.themeWritten, id).toBe(true)
      expect(container.dataset.mmTheme, id).toBe(id)
      expect(container.dataset.mmSkeleton, id).toBe(themeLook(id).skeleton)
      expect(customProperties(container), id).toMatchObject(containerVars(themeLook(id)))
      const drawn = drawnColours(container.parentElement!)

      const reopened = await openXmind(await session.produceBytes())
      if (reopened.status !== 'ok') throw new Error(`${id}: the saved map does not open`)
      expect(recogniseSheetTheme(reopened.document.sheets[0]!), id).toBe(id)
      const again = show(reopened.document)
      expect(again.controller.themeId, id).toBe(id)
      expect(drawnColours(again.el), id).toBe(drawn)
      again.controller.destroy()
      again.el.remove()
    }
  }, 120_000)

  it('picking the theme a sheet already carries writes nothing', async () => {
    const sheet = plainSheet()
    writeSheetTheme(sheet, 'capsule/harbor/tint')
    const { controller, doc, host } = await mount(sheet)
    expect(controller.themeId).toBe('capsule/harbor/tint')
    expect(controller.themeWritten).toBe(true)
    expect(controller.setTheme('capsule/harbor/tint')).toBe(false)
    expect(doc.changed).toBe(false)
    expect(host.onStateChange).not.toHaveBeenCalled()
  })

  it('the document becomes changed when a theme is picked, and not before', async () => {
    const { controller, session } = await mount(plainSheet())
    const heard = vi.fn()
    session.subscribe(heard)
    expect(session.dirty).toBe(false)
    controller.setTheme('block/signal/dark')
    expect(session.dirty).toBe(true)
    expect(heard).toHaveBeenCalled()
  })

  it('picking a theme replaces a theme from another program on that sheet only', async () => {
    const other = plainSheet('Other')
    other.theme = { map: { id: 'kept', properties: { 'svg:fill': '#123456' } } }
    const { controller, doc, session } = await mount(richSheet(), other)
    controller.setTheme('line/clay/light')
    expect(recogniseSheetTheme(doc.sheets[0]!)).toBe('line/clay/light')
    expect(doc.sheets[1]!.theme).toEqual({
      map: { id: 'kept', properties: { 'svg:fill': '#123456' } },
    })
    expect(session.hasUnknownTheme()).toBe(true)
  })

  it('is not a step of the history: undo takes back an edit and leaves the theme', async () => {
    const { controller, doc, mind } = await mount(plainSheet())
    controller.setTheme('pill/moss/light')
    expect(controller.canUndo).toBe(false)
    mind.selectNode(mind.findEle(doc.sheets[0]!.rootTopic.children!.attached![0]!.id))
    controller.setTitle(doc.sheets[0]!.rootTopic.children!.attached![0]!.id, 'Renamed')
    await settle()
    controller.setTheme('block/plum/dark')
    expect(controller.undo()).toBe(true)
    expect(doc.sheets[0]!.rootTopic.children!.attached![0]!.title).toBe('One')
    expect(recogniseSheetTheme(doc.sheets[0]!)).toBe('block/plum/dark')
    expect(controller.themeId).toBe('block/plum/dark')
    expect(controller.redo()).toBe(true)
    expect(recogniseSheetTheme(doc.sheets[0]!)).toBe('block/plum/dark')
  })

  it('keeps the selection and the map itself when the look changes', async () => {
    const { controller, mind, session, key } = await mount(richSheet())
    const before = JSON.stringify(session.view(key))
    mind.selectNode(mind.findEle(IDS.c))
    controller.setTheme('block/poppy/tint')
    expect(controller.selectedTopicIds()).toEqual([IDS.c])
    expect(JSON.stringify(session.view(key))).toBe(before)
  })
})

describe('the levels below the third', () => {
  const DEEP = {
    four: 'bbbbbbbb-0000-4000-8000-000000000004',
    five: 'bbbbbbbb-0000-4000-8000-000000000005',
    six: 'bbbbbbbb-0000-4000-8000-000000000006',
    seven: 'bbbbbbbb-0000-4000-8000-000000000007',
    eight: 'bbbbbbbb-0000-4000-8000-000000000008',
  } as const
  const chain = (): ReturnType<typeof topic> =>
    topic(DEEP.four, 'Four', {}, [
      topic(DEEP.five, 'Five', {}, [
        topic(DEEP.six, 'Six', {}, [topic(DEEP.seven, 'Seven', {}, [topic(DEEP.eight, 'Eight')])]),
      ]),
    ])
  // root > one > sub, and root > two > four > five > six > seven > eight:
  // the last of those is deeper than the theme has sizes for
  const deepSheet = () =>
    sheetOf(topic(ID.one, 'One', {}, [topic(ID.sub, 'Sub')]), topic(ID.two, 'Two', {}, [chain()]))
  const levelOf = (el: HTMLElement, id: string): string | undefined =>
    topicEl(el, id).dataset.mmLevel

  it('marks each level from the fourth down, and a deeper one keeps the last size', async () => {
    const { el } = await mount(deepSheet())
    expect(levelOf(el, ID.root)).toBeUndefined()
    expect(levelOf(el, ID.one)).toBeUndefined()
    expect(levelOf(el, ID.sub)).toBeUndefined()
    expect(levelOf(el, DEEP.four)).toBeUndefined()
    expect(levelOf(el, DEEP.five)).toBe('4')
    expect(levelOf(el, DEEP.six)).toBe('5')
    expect(levelOf(el, DEEP.seven)).toBe('6')
    expect(levelOf(el, DEEP.eight)).toBe('6')
  })

  it('follows a topic that moves deeper or back up', async () => {
    const { el, controller } = await mount(deepSheet())
    controller.edit((root) => {
      const [one, two] = root.children!
      const third = one!.children![0]!
      let deepest = two!.children![0]!
      while (deepest.children?.length) deepest = deepest.children[0]!
      // the third level goes under the deepest topic: deeper than any size
      deepest.children = [...(deepest.children ?? []), third]
      one!.children = one!.children!.filter((child) => child !== third)
    })
    await settle()
    expect(levelOf(el, ID.sub)).toBe('6')
    controller.undo()
    await settle()
    expect(levelOf(el, ID.sub)).toBeUndefined()
  })

  it('is drawn only: the file keeps its three levels and no mark of this one', async () => {
    const { controller, doc, session } = await mount(deepSheet())
    const original = await session.produceBytes()
    controller.flush()
    expect(doc.changed).toBe(false)
    expect(await session.produceBytes()).toEqual(original)
    expect(JSON.stringify(doc.sheets[0])).not.toContain('mmLevel')
  })
})

describe('the colours of the map and the colours of the app', () => {
  it('each main branch takes one colour of the band by its place in the map, and starts over after the last', async () => {
    const sheet = sheetOf(
      topic(ID.one, 'One', {}, [topic(ID.sub, 'Below one')]),
      topic(ID.two, 'Two'),
      topic(ID.three, 'Three'),
      topic(ID.four, 'Four'),
      topic(ID.five, 'Five'),
    )
    const { el } = await mount(sheet)
    const look = themeLook(DEFAULT_THEME_ID)
    const order = [ID.one, ID.two, ID.three, ID.four, ID.five]
    const lines = [...el.querySelectorAll('svg.lines path')]
    const wrappers = [...el.querySelectorAll<HTMLElement>('me-main > me-wrapper')]
    expect(wrappers).toHaveLength(5)
    wrappers.forEach((wrapper, at) => {
      const id = wrapper.querySelector<HTMLElement>('me-tpc')!.dataset.nodeid!.slice(2)
      const index = order.indexOf(id as (typeof order)[number])
      expect(customProperties(wrapper)).toEqual(branchVars(look, index))
      expect(lines[at]!.getAttribute('stroke')).toBe(look.branches[index % 4]!.color)
      // the library's own palette colour is not left on the topic
      expect(wrapper.querySelector<HTMLElement>('me-tpc')!.style.borderColor).toBe('')
    })
    // both sides: the first half of the branches is on the right, and still has the first colours
    const right = el.querySelector('me-main.rhs > me-wrapper me-tpc') as HTMLElement
    expect(right.dataset.nodeid).toBe(`me${ID.one}`)
    expect(
      el
        .querySelector<HTMLElement>('me-main.rhs > me-wrapper')!
        .style.getPropertyValue('--mm-branch'),
    ).toBe(look.branches[0]!.color)
    expect(customProperties(wrappers.find((each) => each.contains(topicEl(el, ID.five)))!)).toEqual(
      branchVars(look, 0),
    )
  })

  it('what the map is drawn with is the same whether the app is light or dark', async () => {
    const sheet = richSheet()
    writeSheetTheme(sheet, 'block/slate/tint')
    document.documentElement.setAttribute('data-theme', 'light')
    const inLight = drawnColours((await mount(sheet)).el)
    document.documentElement.setAttribute('data-theme', 'dark')
    const fresh = richSheet()
    writeSheetTheme(fresh, 'block/slate/tint')
    const dark = await mount(fresh)
    expect(drawnColours(dark.el)).toBe(inLight)
    // and switching the app while the map is open changes nothing on the map
    document.documentElement.setAttribute('data-theme', 'light')
    dark.controller.redraw()
    expect(drawnColours(dark.el)).toBe(inLight)
  })

  it('every colour on the map is a value of its theme or of the file, never a chrome token', async () => {
    const { el, controller } = await mount(richSheet())
    for (const id of ['pill/paper/light', 'line/signal/dark', 'block/plum/tint'] as ThemeId[]) {
      controller.setTheme(id)
      expect(drawnColours(el)).not.toMatch(/var\(/)
      // no property of the app's chrome is set on the map, under its own name
      expect(drawnColours(el)).not.toMatch(
        /"--(?:surface|canvas|text|text-primary|border|hover|accent|accent-soft|accent-dark)"/,
      )
    }
  })
})

describe("a topic's own style values", () => {
  const hostileFill = 'url(https://outside.example/fill.png)'
  const hostile = () =>
    sheetOf(
      topic(ID.one, 'Coloured', style({ 'svg:fill': '#FFE08A', 'fo:color': '#5B3A00' })),
      topic(ID.two, 'Heavy', style({ 'fo:font-weight': 'bold', 'fo:font-size': '18pt' })),
      topic(
        ID.three,
        'Hostile',
        style({
          'svg:fill': hostileFill,
          'fo:color': 'red; background:url(https://outside.example/x)',
          'fo:font-weight': 'expression(alert(1))',
          'fo:font-size': 'calc(100px)',
        }),
      ),
      topic(ID.four, 'Unfilled', style({ 'svg:fill': 'none' }), [
        topic(ID.sub, 'Words', style({ 'fo:color': 'inherited', 'fo:font-weight': 'normal' })),
      ]),
      topic(ID.five, 'Plain'),
    )

  it('a colour and a number are drawn, as values this app wrote out itself', async () => {
    const { el } = await mount(hostile())
    const coloured = topicEl(el, ID.one)
    expect(coloured.style.backgroundColor).toMatch(/^(?:#ffe08a|rgb\(255, 224, 138\))$/)
    expect(coloured.style.color).toMatch(/^(?:#5b3a00|rgb\(91, 58, 0\))$/)
    const heavy = topicEl(el, ID.two)
    expect(heavy.style.fontWeight).toBe('700')
    expect(heavy.style.fontSize).toBe('24px')
    expect(heavy.style.lineHeight).toBe('34px')
    expect(heavy.style.backgroundColor).toBe('')
  })

  it('a fill that is not a colour is not used: the topic has the default fill', async () => {
    const { el } = await mount(hostile())
    const drawn = topicEl(el, ID.three)
    const plain = topicEl(el, ID.five)
    expect(drawn.getAttribute('style') ?? '').toBe(plain.getAttribute('style') ?? '')
    expect(drawn.dataset.mmOwn).toBeUndefined()
    expect(el.innerHTML).not.toContain('outside.example')
    expect(el.innerHTML).not.toContain('expression')
    expect(el.innerHTML).not.toContain('calc(')
  })

  it('and the saved file keeps the value, byte for byte, when nothing was edited', async () => {
    const { controller, doc, session } = await mount(hostile())
    const original = await session.produceBytes()
    controller.flush()
    expect(doc.changed).toBe(false)
    expect(await session.produceBytes()).toEqual(original)
    const properties = (
      doc.sheets[0]!.rootTopic.children!.attached![2]!.style as {
        properties: Record<string, string>
      }
    ).properties
    expect(properties['svg:fill']).toBe(hostileFill)
  })

  it('the value is still in the file after an unrelated edit and a save', async () => {
    const { controller, session } = await mount(hostile())
    controller.setTitle(ID.five, 'Edited')
    await settle()
    const reopened = await openXmind(await session.produceBytes())
    if (reopened.status !== 'ok') throw new Error('the saved map does not open')
    const saved = JSON.stringify(reopened.document.sheets[0])
    expect(saved).toContain(JSON.stringify(hostileFill).slice(1, -1))
    expect(saved).toContain('red; background:url(https://outside.example/x)')
    expect(saved).toContain('expression(alert(1))')
    expect(saved).toContain('"svg:fill":"#FFE08A"')
    expect(saved).toContain('"title":"Edited"')
  })

  it('the known words stand for values of this app: no fill, and the normal weight', async () => {
    const { el } = await mount(hostile())
    const unfilled = topicEl(el, ID.four)
    expect(unfilled.style.backgroundColor).toBe('transparent')
    // read against the ground, not against the fill it no longer has
    expect(unfilled.style.color).toMatch(/^(?:#[0-9a-f]{6}|rgb\(\d+, \d+, \d+\))$/)
    const words = topicEl(el, ID.sub)
    expect(words.style.fontWeight).toBe('400')
    expect(words.style.color).toBe('')
  })

  it('text on a fill of its own is one of the two ends of the band, whichever reads', async () => {
    const { el } = await mount(
      sheetOf(
        topic(ID.one, 'Dark fill', style({ 'svg:fill': '#101820' })),
        topic(ID.two, 'Light fill', style({ 'svg:fill': '#fff4c2' })),
      ),
    )
    expect(topicEl(el, ID.one).style.color).not.toBe(topicEl(el, ID.two).style.color)
    expect(topicEl(el, ID.one).style.color).not.toBe('')
  })

  it('is applied again after the look changes and after the topic is edited', async () => {
    const { el, controller } = await mount(hostile())
    controller.setTheme('block/harbor/dark')
    expect(topicEl(el, ID.one).style.backgroundColor).toMatch(/^(?:#ffe08a|rgb\(255, 224, 138\))$/)
    controller.setLabels(ID.one, ['label'])
    await settle()
    expect(topicEl(el, ID.one).style.backgroundColor).toMatch(/^(?:#ffe08a|rgb\(255, 224, 138\))$/)
    expect(topicEl(el, ID.three).style.backgroundColor).toBe('')
  })
})

describe('markers', () => {
  const marked = () =>
    sheetOf(
      topic(ID.one, 'Known', { markers: [{ markerId: 'priority-2' }, { markerId: 'task-half' }] }),
      topic(ID.two, 'Flag and star', {
        markers: [{ markerId: 'flag-red' }, { markerId: 'star-blue' }],
      }),
      topic(ID.three, 'Unknown', {
        markers: [{ markerId: 'symbol-made-up' }, { markerId: 'flag-red"><img src=x>' }],
      }),
      topic(ID.four, 'None'),
    )
  const families = (el: HTMLElement, id: string): (string | undefined)[] =>
    [...topicEl(el, id).querySelectorAll<SVGElement>('.mm-marker')].map(
      (glyph) => glyph.dataset.markerFamily,
    )

  it('a known id gets the glyph of its family, in the order of the file, in front of the title', async () => {
    const { el } = await mount(marked())
    expect(families(el, ID.one)).toEqual(['priority', 'progress'])
    expect(families(el, ID.two)).toEqual(['flag', 'star'])
    const known = topicEl(el, ID.one)
    expect(known.firstElementChild!.className).toBe('mm-markers')
    expect(known.querySelector('.text')!.textContent).toBe('Known')
    expect(
      [...known.querySelectorAll('.mm-marker')].map((glyph) => glyph.getAttribute('aria-label')),
    ).toEqual(['우선순위 2', '진행 50%'])
  })

  it('an id the app does not know gets the one common glyph, and nothing of the id reaches the page', async () => {
    const { el } = await mount(marked())
    expect(families(el, ID.three)).toEqual(['other', 'other'])
    expect(topicEl(el, ID.three).querySelectorAll('.mm-marker')[0]!.outerHTML).toBe(
      topicEl(el, ID.three).querySelectorAll('.mm-marker')[1]!.outerHTML,
    )
    expect(el.querySelector('img')).toBeNull()
    expect(el.innerHTML).not.toContain('symbol-made-up')
    expect(topicEl(el, ID.four).querySelector('.mm-markers')).toBeNull()
  })

  it('stay on the topic through an edit, an undo and a new look, and in the file', async () => {
    const { el, controller, doc } = await mount(marked())
    controller.setTitle(ID.one, 'Renamed')
    await settle()
    expect(families(el, ID.one)).toEqual(['priority', 'progress'])
    expect(topicEl(el, ID.one).querySelectorAll('.mm-markers')).toHaveLength(1)
    controller.undo()
    expect(families(el, ID.one)).toEqual(['priority', 'progress'])
    controller.setTheme('line/moss/light')
    expect(families(el, ID.three)).toEqual(['other', 'other'])
    expect(doc.sheets[0]!.rootTopic.children!.attached![2]!.markers).toEqual([
      { markerId: 'symbol-made-up' },
      { markerId: 'flag-red"><img src=x>' },
    ])
  })

  it('are named in the language of the app', async () => {
    const { el, controller } = await mount(marked())
    controller.setStrings(mapStrings('en'))
    expect(
      [...topicEl(el, ID.one).querySelectorAll('.mm-marker')].map((glyph) =>
        glyph.getAttribute('aria-label'),
      ),
    ).toEqual(['Priority 2', 'Progress 50%'])
    expect(topicEl(el, ID.three).querySelector('.mm-marker')!.getAttribute('aria-label')).toBe(
      'Marker',
    )
  })
})

describe('pictures', () => {
  const svgPicture = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>fetch("https://outside.example/from-script")</script>' +
      '<image href="https://outside.example/from-svg.png" width="5" height="5"/></svg>',
  )
  const outside = [
    'https://outside.example/a.png',
    'http://outside.example/a.png',
    '//outside.example/a.png',
    'file:///C:/Users/someone/a.png',
    'C:\\Users\\someone\\a.png',
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'javascript:alert(1)',
    'xap:../content.json',
    'xap:Thumbnails/thumbnail.png',
    'xap:resources/../../outside.png',
    'xap:https://outside.example/a.png',
  ]
  const pictured = () =>
    sheetOf(
      topic(ID.one, 'PNG inside', {
        image: { src: 'xap:resources/inside.png', width: 40, height: 30 },
      }),
      topic(ID.two, 'SVG inside', { image: { src: 'xap:resources/drawing.svg' } }),
      topic(ID.three, 'Missing entry', { image: { src: 'xap:resources/not-there.png' } }),
      topic(ID.four, 'Not a picture', { image: { src: 'xap:resources/page.png' } }),
      topic(
        ID.five,
        'Outside',
        {},
        outside.map((src, at) =>
          topic(
            `aaaaaaaa-0000-4000-8000-0000000001${at.toString().padStart(2, '0')}`,
            `Outside ${at}`,
            {
              image: { src, width: 20, height: 20 },
            },
          ),
        ),
      ),
    )
  const entries = {
    'resources/inside.png': TINY_PNG,
    'resources/drawing.svg': svgPicture,
    'resources/page.png': new TextEncoder().encode('<html><body>not a picture</body></html>'),
  }
  const mountPictures = async () => {
    const fetched = vi.fn(async () => new Response(''))
    vi.stubGlobal('fetch', fetched)
    const shown = show(await documentWithEntries([pictured()], entries))
    // the pictures are read out of the zip first; the image element waits for its source
    await until(
      () =>
        [ID.one, ID.two].every(
          (id) => !!topicEl(shown.el, id).querySelector('.mm-picture img[src^="blob:"]'),
        ),
      'the pictures inside the file',
      { react: false },
    )
    await settle()
    await settle()
    return { ...shown, fetched }
  }
  afterEach(() => vi.unstubAllGlobals())

  it('a picture inside the file is shown through an image element fed from an object URL', async () => {
    const { el } = await mountPictures()
    const png = topicEl(el, ID.one).querySelector<HTMLImageElement>('.mm-picture img')!
    expect(png.getAttribute('src')).toMatch(/^blob:/)
    expect([png.getAttribute('width'), png.getAttribute('height')]).toEqual(['40', '30'])
    expect(png.getAttribute('alt')).toBe('')
    // above the title, which is still the title
    expect(topicEl(el, ID.one).firstElementChild!.className).toBe('mm-picture')
    expect(topicEl(el, ID.one).querySelector('.text')!.textContent).toBe('PNG inside')
  })

  it('an SVG picture is an image resource too, and never part of the page', async () => {
    const { el } = await mountPictures()
    const svg = topicEl(el, ID.two).querySelector<HTMLImageElement>('.mm-picture img')!
    expect(svg.getAttribute('src')).toMatch(/^blob:/)
    expect(svg.getAttribute('src')).not.toBe(
      topicEl(el, ID.one).querySelector('img')!.getAttribute('src'),
    )
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('image')).toBeNull()
    expect(el.innerHTML).not.toContain('outside.example')
    expect(el.innerHTML).not.toContain('from-script')
  })

  it('a picture that points outside the file makes no element with a source: only its place is marked', async () => {
    const { el, fetched } = await mountPictures()
    const images = [...el.querySelectorAll('img')]
    expect(images).toHaveLength(2)
    for (const img of images) expect(img.getAttribute('src')).toMatch(/^blob:/)
    const placeholders = topicEl(el, ID.five).parentElement!.parentElement!.querySelectorAll(
      'me-children .mm-picture-missing',
    )
    expect(placeholders).toHaveLength(outside.length)
    for (const mark of placeholders) {
      expect(mark.querySelector('img')).toBeNull()
      expect(mark.getAttribute('aria-label')).toBe('불러오지 않은 그림')
    }
    // nothing on the page carries one of those addresses, in any attribute or style
    const page = document.documentElement.outerHTML
    for (const needle of [
      'outside.example',
      'someone',
      'javascript:',
      'data:image',
      'content.json',
    ]) {
      expect(page, needle).not.toContain(needle)
    }
    expect(
      el.querySelectorAll('[src]:not([src^="blob:"]), [href], [srcset], [background]'),
    ).toHaveLength(0)
    expect(fetched).not.toHaveBeenCalled()
  })

  it('an entry that is missing, or is not a picture, is marked the same way', async () => {
    const { el } = await mountPictures()
    for (const id of [ID.three, ID.four]) {
      expect(topicEl(el, id).querySelector('img'), id).toBeNull()
      expect(topicEl(el, id).querySelector('.mm-picture-missing'), id).not.toBeNull()
    }
  })

  it('only archive entries are read, each once, and never the map itself', async () => {
    const doc = await documentWithEntries([pictured()], entries)
    const read = vi.spyOn(doc, 'readEntry')
    show(doc)
    await settle()
    expect(read.mock.calls.map(([name]) => name).sort()).toEqual([
      'resources/drawing.svg',
      'resources/inside.png',
      'resources/not-there.png',
      'resources/page.png',
    ])
  })

  it('the file keeps every picture reference, shown or not', async () => {
    const { controller, doc, session } = await mountPictures()
    const original = await session.produceBytes()
    controller.flush()
    expect(doc.changed).toBe(false)
    expect(await session.produceBytes()).toEqual(original)
    controller.setTitle(ID.one, 'Edited')
    await settle()
    const saved = JSON.stringify(doc.sheets[0])
    for (const src of outside) expect(saved).toContain(JSON.stringify(src).slice(1, -1))
  })

  it('stays through an edit of its topic and a new look, and its object URLs are given back at the end', async () => {
    const made = vi.spyOn(URL, 'createObjectURL')
    const revoked = vi.spyOn(URL, 'revokeObjectURL')
    const { el, controller } = await mountPictures()
    const source = topicEl(el, ID.one).querySelector('img')!.getAttribute('src')!
    const urls = made.mock.results.map((result) => result.value as string)
    expect(urls).toHaveLength(2)
    expect(urls).toContain(source)
    expect(revoked).not.toHaveBeenCalled()
    controller.setLabels(ID.one, ['label'])
    await settle()
    expect(topicEl(el, ID.one).querySelectorAll('.mm-picture img')).toHaveLength(1)
    controller.setTheme('block/clay/light')
    // already loaded: the picture is there at once, from the same object URL
    expect(topicEl(el, ID.one).querySelector('img')!.getAttribute('src')).toBe(source)
    expect(made).toHaveBeenCalledTimes(2)
    controller.destroy()
    expect(revoked.mock.calls.map(([url]) => url).sort()).toEqual([...urls].sort())
  })

  it('a topic pasted from the clipboard cannot bring a picture, a marker or a style', async () => {
    const { mind, el } = await mountPictures()
    const pasted = {
      id: 'pasted',
      topic: 'Pasted',
      image: { url: 'https://outside.example/pasted.png', width: 10, height: 10 },
      style: { background: 'url(https://outside.example/pasted-style.png)' },
      metadata: {
        image: { src: 'https://outside.example/meta.png', entryName: 'resources/inside.png' },
        markers: ['priority-1'],
        style: { fill: '#ff0000' },
      },
    }
    mind.selectNode(mind.findEle(ID.four))
    await mind.copyNode({ nodeObj: pasted } as never, mind.findEle(ID.four))
    await settle()
    const added = [...el.querySelectorAll<HTMLElement>('me-tpc')].find(
      (each) => each.querySelector('.text')?.textContent === 'Pasted',
    )!
    expect(added.querySelector('img, .mm-picture, .mm-markers')).toBeNull()
    expect(added.style.backgroundColor).toBe('')
    expect(el.innerHTML).not.toContain('pasted.png')
    expect(el.innerHTML).not.toContain('pasted-style')
  })
})

describe('drawing the lines again', () => {
  it('a picture that arrives while its sheet is hidden has the lines drawn once the sheet is shown', async () => {
    const doc = await documentWithEntries(
      [sheetOf(topic(ID.one, 'Picture', { image: { src: 'xap:resources/inside.png' } }))],
      { 'resources/inside.png': TINY_PNG },
    )
    const { controller, mind, el } = show(doc)
    const linkDiv = vi.spyOn(mind, 'linkDiv')
    await settle()
    // nothing in this test environment has a size, so the sheet counts as hidden
    el.querySelector('img')!.dispatchEvent(new Event('load'))
    await settle()
    expect(linkDiv).not.toHaveBeenCalled()
    controller.onShown()
    expect(linkDiv).toHaveBeenCalledTimes(1)
    controller.onShown()
    expect(linkDiv).toHaveBeenCalledTimes(1)
  })
})

describe('the edit box', () => {
  it('has the weight and the line height of the topic it stands in for', async () => {
    const { el, mind } = await mount(sheetOf(topic(ID.one, 'Main topic')))
    const main = topicEl(el, ID.one)
    main.style.fontWeight = '650'
    main.style.lineHeight = '22px'
    await mind.beginEdit(mind.findEle(ID.one))
    const box = el.querySelector<HTMLElement>('#input-box')!
    expect(box.style.fontWeight).toBe('650')
    expect(box.style.lineHeight).toBe('22px')
  })
})
