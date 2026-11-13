/**
 * Group `d1/slides-edits`: the deck's edit channels (elements, slides, tables,
 * charts, sections, history, transactions) of `apps/slides/src/main/slides-main.ts`,
 * loaded as the shell loads it (`d1/slides-host.ts`).
 *
 * The fake executor (`d1/slides-engine.ts`) applies `addElement`, `setText`,
 * `deleteElement`, `setHidden`, `deleteSlide`, `duplicateSlide`, `addComment`,
 * `deleteComment` and `addPicture` to its tiny deck, makes an element for the ops
 * that create one, accepts every other op that names a slide and an element
 * that exist, and fails the rest the same way on both sides. Each channel is called
 * on a deck with arguments that apply, with arguments that cannot, and, in the
 * first case, with no deck at all.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { OPEN_A, call, slidesCase } from '../../d1/slides-cases.ts'
import type { Call, Case, Group } from '../../types.ts'

const box = { xPx: 10, yPx: 20, wPx: 100, hPx: 50, fitWidthPx: 1280 }
const para = (text: string) => [{ runs: [{ text }] }]
const el = { slideIndex: 0, sourceId: 'e1' }
const gone = { slideIndex: 0, sourceId: 'nope' }
const past = { slideIndex: 9, sourceId: 'e1' }

/** `[channel, arguments that apply, arguments that cannot]` */
const TABLE: [string, unknown[], unknown[]][] = [
  [
    'slides:add-element',
    [{ slideIndex: 0, kind: 'text', text: 'hi', ...box }],
    [{ slideIndex: 9, kind: 'text', ...box }],
  ],
  [
    'slides:add-table',
    [{ slideIndex: 0, rows: 2, cols: 2, ...box }],
    [{ slideIndex: 9, rows: 2, cols: 2, ...box }],
  ],
  [
    'slides:add-chart',
    [
      {
        slideIndex: 0,
        kind: 'bar',
        categories: ['a'],
        series: [{ name: 's', values: [1] }],
        ...box,
      },
    ],
    [
      {
        slideIndex: 9,
        kind: 'bar',
        categories: ['a'],
        series: [{ name: 's', values: [1] }],
        ...box,
      },
    ],
  ],
  [
    'slides:add-smartart',
    [{ slideIndex: 0, layout: 'list', items: ['a', 'b'], ...box }],
    [{ slideIndex: 9, layout: 'list', items: ['a'], ...box }],
  ],
  [
    'slides:add-slide',
    [{ sourceIndex: 0, fitWidthPx: 1280 }],
    [{ sourceIndex: 9, fitWidthPx: 1280 }],
  ],
  [
    'slides:add-slide-with-layout',
    [{ sourceIndex: 0, layoutPath: 'builtin:title', fitWidthPx: 1280 }],
    [{ sourceIndex: 9, layoutPath: 'builtin:title', fitWidthPx: 1280 }],
  ],
  [
    'slides:add-blank-slide',
    [{ sourceIndex: 0, fitWidthPx: 1280 }],
    [{ sourceIndex: 9, fitWidthPx: 1280 }],
  ],
  ['slides:apply-edit-script', [{ slideIndex: 0, steps: [] }], [{}]],
  [
    'slides:apply-header-footer',
    [{ footer: 'foot', slideNum: true, fitWidthPx: 1280 }],
    [{ fitWidthPx: 800 }],
  ],
  [
    'slides:apply-theme',
    [{ name: 'Theme', colors: { accent1: '#112233' }, fitWidthPx: 1280 }],
    [{ name: 'Other', colors: {}, minorFont: 'Arial', fitWidthPx: 900 }],
  ],
  [
    'slides:apply-txn',
    [{ ops: [{ op: 'setHidden', target: { slide: 0 }, hidden: true }] }],
    [{ ops: [] }],
  ],
  [
    'slides:batch-edit-transform',
    [
      {
        slideIndex: 0,
        fitWidthPx: 1280,
        items: [{ sourceId: 'e1', xPx: 1, yPx: 2, wPx: 3, hPx: 4, rotationDeg: 0 }],
      },
    ],
    [
      {
        slideIndex: 0,
        fitWidthPx: 1280,
        items: [{ sourceId: 'nope', xPx: 1, yPx: 2, wPx: 3, hPx: 4, rotationDeg: 0 }],
      },
    ],
  ],
  ['slides:cancel-transform-preview', [{ slideIndex: 0 }], [{ slideIndex: 9 }]],
  ['slides:change-shape', [{ ...el, prst: 'ellipse' }], [{ ...gone, prst: 'ellipse' }]],
  ['slides:chart-color-schemes', [], []],
  ['slides:delete-element', [el], [gone]],
  [
    'slides:delete-elements',
    [{ slideIndex: 0, sourceIds: ['e1', 'e2'] }],
    [{ slideIndex: 0, sourceIds: ['nope'] }],
  ],
  ['slides:delete-slide', [0], [9]],
  ['slides:delete-slides', [{ slideIndexes: [0] }], [{ slideIndexes: [9] }]],
  [
    'slides:duplicate-slides',
    [{ slideIndexes: [0], fitWidthPx: 1280 }],
    [{ slideIndexes: [9], fitWidthPx: 1280 }],
  ],
  ['slides:edit-chart', [{ ...el, kind: 'bar' }], [{ ...gone, kind: 'bar' }]],
  [
    'slides:edit-connector-endpoints',
    [{ ...el, x1Px: 0, y1Px: 0, x2Px: 5, y2Px: 5, fitWidthPx: 1280 }],
    [{ ...gone, x1Px: 0, y1Px: 0, x2Px: 5, y2Px: 5, fitWidthPx: 1280 }],
  ],
  ['slides:edit-fill', [{ ...el, fill: '#ff0000' }], [{ ...gone, fill: '#ff0000' }]],
  ['slides:edit-picture-opacity', [{ ...el, opacity: 0.5 }], [{ ...gone, opacity: 0.5 }]],
  [
    'slides:edit-picture-src-rect',
    [{ ...el, srcRect: { l: 0, t: 0, r: 0, b: 0 } }],
    [{ ...gone, srcRect: null }],
  ],
  [
    'slides:edit-stroke',
    [{ ...el, stroke: { color: '#000000', widthPt: 1 } }],
    [{ ...gone, stroke: { color: '#000000', widthPt: 1 } }],
  ],
  [
    'slides:edit-table-cell',
    [{ ...el, row: 0, col: 0, paragraphs: para('c') }],
    [{ ...gone, row: 0, col: 0, paragraphs: para('c') }],
  ],
  ['slides:edit-table-style', [{ ...el, styleName: 'Medium' }], [{ ...gone, styleName: 'Medium' }]],
  ['slides:edit-text', [{ ...el, paragraphs: para('Z') }], [{ ...gone, paragraphs: para('Z') }]],
  [
    'slides:edit-transform',
    [{ ...el, ...box, rotationDeg: 5 }],
    [{ ...gone, ...box, rotationDeg: 5 }],
  ],
  [
    'slides:edit-transform-multi',
    [
      {
        slideIndex: 0,
        fitWidthPx: 1280,
        items: [{ sourceId: 'e1', xPx: 1, yPx: 2, wPx: 3, hPx: 4, rotationDeg: 0 }],
      },
    ],
    [
      {
        slideIndex: 9,
        fitWidthPx: 1280,
        items: [{ sourceId: 'e1', xPx: 1, yPx: 2, wPx: 3, hPx: 4, rotationDeg: 0 }],
      },
    ],
  ],
  [
    'slides:find-replace',
    [{ find: 'Hello', replace: 'Bye' }],
    [{ find: 'Hello', replace: 'Bye', slideIndex: 9 }],
  ],
  [
    'slides:flip-elements',
    [{ slideIndex: 0, sourceIds: ['e1'], axis: 'h' }],
    [{ slideIndex: 0, sourceIds: ['nope'], axis: 'v' }],
  ],
  ['slides:get-chart-data', [0, 'e1'], [9, 'nope']],
  ['slides:get-layouts', [], []],
  [
    'slides:group-elements',
    [{ slideIndex: 0, sourceIds: ['e1', 'e2'] }],
    [{ slideIndex: 9, sourceIds: ['e1'] }],
  ],
  ['slides:history-batch-begin', [], []],
  ['slides:history-batch-end', [], []],
  ['slides:add-section', [{ atSlideIndex: 0, name: 'Intro' }], [{ atSlideIndex: 9, name: 'Late' }]],
  ['slides:rename-section', [{ id: 's1', name: 'Renamed' }], [{ id: 'x', name: 'Other' }]],
  ['slides:remove-section', [{ id: 's1' }], [{ id: 'x' }]],
  ['slides:move-section', [{ id: 's1', dir: 'up' }], [{ id: 'x', dir: 'down' }]],
  ['slides:set-sections', [[{ id: 's1', name: 'One', slideIds: [] }]], [[]]],
  ['slides:move-slide', [{ fromIndex: 0, toIndex: 1 }], [{ fromIndex: 9, toIndex: 0 }]],
  ['slides:reorder-element', [{ ...el, dir: 'front' }], [{ ...gone, dir: 'back' }]],
  [
    'slides:set-advance-times',
    [{ times: [{ slideIndex: 0, ms: 1000 }] }],
    [{ times: [{ slideIndex: 9, ms: null }] }],
  ],
  ['slides:set-animations', [{ slideIndex: 0, items: [] }], [{ slideIndex: 9, items: [] }]],
  ['slides:set-effects', [{ ...el, effects: {} }], [{ ...gone, effects: {} }]],
  [
    'slides:set-element-font',
    [{ slideIndex: 0, sourceIds: ['e1'], bold: true }],
    [{ slideIndex: 0, sourceIds: ['nope'], bold: true }],
  ],
  ['slides:set-element-hidden', [{ ...el, hidden: true }], [{ ...gone, hidden: true }]],
  ['slides:set-element-name', [{ ...el, name: 'Title' }], [{ ...gone, name: 'Title' }]],
  [
    'slides:set-element-paragraph-format',
    [{ slideIndex: 0, sourceIds: ['e1'], bullet: 'none' }],
    [{ slideIndex: 0, sourceIds: ['nope'], bullet: 'none' }],
  ],
  ['slides:set-hidden', [{ slideIndex: 0, hidden: true }], [{ slideIndex: 9, hidden: true }]],
  [
    'slides:set-slides-hidden',
    [{ slideIndexes: [0, 1], hidden: true }],
    [{ slideIndexes: [], hidden: true }],
  ],
  ['slides:set-notes', [{ slideIndex: 0, text: 'note' }], [{ slideIndex: 9, text: 'note' }]],
  [
    'slides:set-shape-adjust',
    [{ ...el, adjust: { adj: 5000 } }],
    [{ ...gone, adjust: { adj: 5000 } }],
  ],
  [
    'slides:set-shape-geometry',
    [{ ...el, pathPx: { w: 10, h: 10, cmds: [] }, fitWidthPx: 1280 }],
    [{ ...gone, pathPx: { w: 10, h: 10, cmds: [] }, fitWidthPx: 1280 }],
  ],
  [
    'slides:set-slide-layout',
    [{ slideIndex: 0, layoutPath: 'ppt/slideLayouts/slideLayout2.xml' }],
    [{ slideIndex: 9, layoutPath: 'ppt/slideLayouts/slideLayout2.xml' }],
  ],
  ['slides:set-slide-size', [{ cx: 12192000, cy: 6858000 }], [{ cx: 0, cy: 0 }]],
  [
    'slides:set-table-cell-anchor',
    [{ ...el, row: 0, col: 0, anchor: 'middle' }],
    [{ ...gone, row: 0, col: 0, anchor: 'top' }],
  ],
  [
    'slides:set-table-col-width',
    [{ ...el, col: 0, wPx: 80, fitWidthPx: 1280 }],
    [{ ...gone, col: 0, wPx: 80, fitWidthPx: 1280 }],
  ],
  [
    'slides:set-table-row-height',
    [{ ...el, row: 0, hPx: 30, fitWidthPx: 1280 }],
    [{ ...gone, row: 0, hPx: 30, fitWidthPx: 1280 }],
  ],
  ['slides:set-text-anchor', [{ ...el, anchor: 'middle' }], [{ ...gone, anchor: 'top' }]],
  [
    'slides:set-text-body-props',
    [{ ...el, props: { wrap: true } }],
    [{ ...gone, props: { autofit: 'none' } }],
  ],
  ['slides:set-transition', [{ slideIndex: 0, kind: 'fade' }], [{ slideIndex: 9, kind: 'fade' }]],
  [
    'slides:table-merge',
    [{ ...el, kind: 'merge-right', row: 0, col: 0 }],
    [{ ...gone, kind: 'split', row: 0, col: 0 }],
  ],
  [
    'slides:table-structure',
    [{ ...el, kind: 'insert-row', index: 0 }],
    [{ ...gone, kind: 'delete-row', index: 0 }],
  ],
  ['slides:ungroup-element', [el], [past]],
]

/** the TS reads arguments loosely: these are the ones no sane renderer sends */
const ODD: [string, unknown[]][] = [
  ['slides:edit-text', [{ slideIndex: 0, sourceId: 'e1', paragraphs: 'not a list' }]],
  ['slides:edit-text', [{ slideIndex: '0', sourceId: 'e1', paragraphs: para('S') }]],
  ['slides:delete-slide', ['0']],
  ['slides:delete-slide', [-1]],
  ['slides:delete-slides', [{ slideIndexes: [0, 0, 1] }]],
  ['slides:duplicate-slides', [{ slideIndexes: [1, 0], fitWidthPx: 640 }]],
  ['slides:move-slide', [{ fromIndex: 1, toIndex: 0 }]],
  ['slides:set-slides-hidden', [{ slideIndexes: [0, 9], hidden: false }]],
  ['slides:set-transition', [{ slideIndex: -1, kind: 'push' }]],
  ['slides:set-advance-times', [{ times: [] }]],
  ['slides:apply-txn', [{ ops: [{ op: 'setHidden', target: { slide: 9 }, hidden: true }] }]],
  [
    'slides:apply-txn',
    [{ ops: [{ op: 'setHidden', target: { slide: 0 }, hidden: true }], dryRun: true }],
  ],
  [
    'slides:apply-txn',
    [
      {
        ops: [
          { op: 'deleteElement', target: { slide: 0, el: 'e1' } },
          { op: 'deleteElement', target: { slide: 0, el: 'nope' } },
        ],
        isolation: 'per_op',
      },
    ],
  ],
]

const caseOf = (note: string, calls: Call[]): Case => slidesCase(note, {}, [OPEN_A, ...calls])

const cases: Case[] = [
  slidesCase(
    'every edit channel without a deck',
    {},
    TABLE.map(([channel, good]) => call(channel, good)),
  ),
  // one case per few channels: a failing channel's history must not hide another's answer
  ...Array.from({ length: Math.ceil(TABLE.length / 6) }, (_, n) => {
    const chunk = TABLE.slice(n * 6, n * 6 + 6)
    return caseOf(
      `${chunk.map(([c]) => c.slice(7)).join(', ')}: arguments that apply, then arguments that cannot`,
      chunk.flatMap(([channel, good, bad]) => [
        call(channel, good),
        call(channel, bad),
        call('slides:is-dirty'),
        call('slides:undo'),
        call('slides:get-render-slides'),
      ]),
    )
  }),
  caseOf(
    'arguments of the wrong shape',
    ODD.flatMap(([channel, args]) => [call(channel, args), call('slides:is-dirty')]),
  ),
  caseOf('a step is undone and redone, twice, and the stacks run out', [
    call('slides:set-hidden', [{ slideIndex: 0, hidden: true }]),
    call('slides:edit-text', [{ ...el, paragraphs: para('One') }]),
    call('slides:undo'),
    call('slides:undo'),
    call('slides:undo'),
    call('slides:redo'),
    call('slides:redo'),
    call('slides:redo'),
    call('slides:delete-slide', [0]),
    call('slides:redo'),
  ]),
  caseOf('a history batch makes one undo step', [
    call('slides:history-batch-begin'),
    call('slides:set-hidden', [{ slideIndex: 0, hidden: true }]),
    call('slides:edit-text', [{ ...el, paragraphs: para('Batch') }]),
    call('slides:history-batch-begin'),
    call('slides:set-hidden', [{ slideIndex: 1, hidden: true }]),
    call('slides:history-batch-end'),
    call('slides:history-batch-end'),
    call('slides:history-batch-end'),
    call('slides:undo'),
    call('slides:get-render-slides'),
  ]),
  caseOf('a transform preview pushes one step and a cancel puts the redo stack back', [
    call('slides:set-hidden', [{ slideIndex: 0, hidden: true }]),
    call('slides:undo'),
    call('slides:edit-transform', [{ ...el, ...box, rotationDeg: 0, preview: true }]),
    call('slides:edit-transform', [{ ...el, ...box, rotationDeg: 9, preview: true }]),
    call('slides:cancel-transform-preview', [{ slideIndex: 0 }]),
    call('slides:redo'),
    call('slides:edit-transform', [{ ...el, ...box, rotationDeg: 9, preview: true }]),
    call('slides:edit-transform', [{ ...el, ...box, rotationDeg: 9 }]),
    call('slides:undo'),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:chart-color-schemes': 'takes no argument and answers the deck-independent scheme list',
    'slides:apply-edit-script':
      "the fake mapScriptOps maps no op, so the one answer is the handler's empty-script answer",
    'slides:get-chart-data':
      'the fake deck holds no chart: the answer is null with or without a deck',
  },
}
