/**
 * Group `d1/slides-master`: the master view's nine channels
 * (`apps/slides/src/main/slides-main.ts`, "Master edit view"), loaded as the
 * shell loads it (`d1/slides-host.ts`). The fake deck has one master part with
 * one title element; the fake executor applies `setText`, `deleteElement` and
 * `addElement` to it and refuses the other ops, on both sides.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { OPEN_A, UNDEFINED, call, slidesCase } from '../../d1/slides-cases.ts'
import type { Case, Group } from '../../types.ts'

const PART = 'ppt/slideMasters/slideMaster1.xml'
const para = (text: string) => [{ runs: [{ text }] }]
const enter = call('slides:master-enter', [1280])
const edit = (sourceId: string, text: string) =>
  call('slides:master-edit-text', [{ sourceId, paragraphs: para(text) }])
const move = (sourceId: string, preview: boolean) =>
  call('slides:master-edit-transform', [
    { sourceId, xPx: 10, yPx: 20, wPx: 300, hPx: 80, rotationDeg: 15, fitWidthPx: 1280, preview },
  ])
const add = (extra: Record<string, unknown> = {}) =>
  call('slides:master-add-element', [
    { kind: 'text', xPx: 5, yPx: 6, wPx: 100, hPx: 40, fitWidthPx: 1280, ...extra },
  ])

const cases: Case[] = [
  slidesCase('every master channel without a deck answers null', {}, [
    enter,
    call('slides:master-open', [PART]),
    call('slides:master-close'),
    edit('m0', 'x'),
    move('m0', false),
    call('slides:master-edit-fill', [{ sourceId: 'm0', fill: '#ff0000' }]),
    call('slides:master-edit-stroke', [{ sourceId: 'm0', stroke: null }]),
    call('slides:master-delete-element', [{ sourceId: 'm0' }]),
    add(),
  ]),
  slidesCase('the editing channels answer null before the view is entered', {}, [
    OPEN_A,
    edit('m0', 'x'),
    move('m0', false),
    call('slides:master-delete-element', [{ sourceId: 'm0' }]),
    add(),
    call('slides:master-close'),
  ]),
  slidesCase('the view is entered, edited and left', {}, [
    OPEN_A,
    enter,
    edit('m0', 'New title'),
    edit('nope', 'x'),
    add({ paragraphs: para('Added') }),
    add(),
    call('slides:master-delete-element', [{ sourceId: 'm0' }]),
    call('slides:master-delete-element', [{ sourceId: 'm0' }]),
    call('slides:is-dirty'),
    call('slides:master-close'),
    call('slides:get-render-slides'),
  ]),
  slidesCase('a part is opened by its path', {}, [
    OPEN_A,
    enter,
    call('slides:master-open', [PART]),
    call('slides:master-open', ['ppt/slideMasters/none.xml']),
    call('slides:master-open', [UNDEFINED]),
    edit('m0', 'after reopening'),
  ]),
  slidesCase('a transform is previewed and then committed as one step', {}, [
    OPEN_A,
    enter,
    move('m0', true),
    move('m0', true),
    move('nope', true),
    move('m0', false),
    call('slides:undo'),
    call('slides:master-close'),
    call('slides:undo'),
  ]),
  slidesCase('fill and stroke edits are refused by the fake executor', {}, [
    OPEN_A,
    enter,
    call('slides:master-edit-fill', [{ sourceId: 'm0', fill: '#00ff00' }]),
    call('slides:master-edit-fill', [
      { sourceId: 'm0', fill: { gradient: { from: '#000000', to: '#ffffff', angleDeg: 90 } } },
    ]),
    call('slides:master-edit-stroke', [{ sourceId: 'm0', stroke: { color: '#112233', widthPt: 2 } }]),
    call('slides:master-edit-stroke', [{ sourceId: 'm0', stroke: null }]),
    call('slides:is-dirty'),
  ]),
  slidesCase('undo and redo do nothing in the master view', {}, [
    OPEN_A,
    call('slides:set-hidden', [{ slideIndex: 0, hidden: true }]),
    enter,
    call('slides:undo'),
    call('slides:master-close'),
    call('slides:undo'),
    call('slides:redo'),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:master-edit-fill': 'the fake executor refuses setFill on a master part: the handler answers null',
    'slides:master-edit-stroke': 'the fake executor refuses setStroke on a master part: the handler answers null',
  },
}
