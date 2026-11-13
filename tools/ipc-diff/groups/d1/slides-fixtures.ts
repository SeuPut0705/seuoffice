/**
 * Group `d1/slides-fixtures`: the channels that read what a real deck holds,
 * on a fake deck that holds it. A case's `hosts.d1.slides.fixtures` puts notes,
 * links, transitions, timings, animations, a header and footer, a chart, media
 * and 3D model parts, sections, narration, a redaction mark, private fonts and a
 * script mapping into the deck (`crates/shell-ipc/d1/src/slides/fixtures.rs`,
 * `d1/slides-engine.ts`), the same on both sides, so each answer is compared with
 * something in it and with nothing in it.
 *
 * The deck is `a.pptx`: slide 0 has `e1` and `e2`, slide 1 has `e3`; an element's
 * spid is the number in its id.
 */
import { loadSlides, slidesTriggers } from '../../d1/slides-host.ts'
import { OPEN_A, UNDEFINED, bin, call, slidesCase } from '../../d1/slides-cases.ts'
import type { Call, Case, Group } from '../../types.ts'

const FIXTURES = {
  notes: { '0': 'Remember to smile', '1': 'Second page' },
  transitions: { '0': 'fade', '1': 'push' },
  advanceMs: { '0': 3000 },
  narration: { '0': [1] },
  animations: {
    '0': [
      { delayMs: 0, durationMs: 500, effect: 'fade', spid: 1, trigger: 'click' },
      {
        delayMs: 250,
        direction: 'left',
        durationMs: 750,
        effect: 'wipe',
        spid: 2,
        trigger: 'after',
      },
      { delayMs: 0, durationMs: 100, effect: 'zoom', spid: 99, trigger: 'click' },
    ],
  },
  headerFooter: { '0': { date: '2026-11-14', footer: 'Confidential', slideNum: true } },
  links: {
    e1: { kind: 'url', url: 'https://example.com/a' },
    e3: { kind: 'slide', slideIndex: 0 },
  },
  runLinks: { e2: [{ end: 5, start: 0, target: { kind: 'url', url: 'https://x.example/' } }] },
  charts: { e1: { categories: ['a', 'b'], kind: 'bar', series: [{ name: 's', values: [1, 2] }] } },
  media: {
    e2: { external: false, kind: 'video', target: 'ppt/media/clip.mp4' },
    e3: { external: true, kind: 'audio', target: 'https://example.com/a.mp3' },
  },
  models: { e1: { target: 'ppt/media/model.glb' } },
  parts: { 'ppt/media/clip.mp4': 'video-bytes', 'ppt/media/model.glb': 'glb-bytes' },
  sections: [
    { id: 's1', name: 'Intro', slideIndices: [0] },
    { id: 's2', name: 'Rest', slideIndices: [1] },
  ],
  fontFaces: [{ family: 'Test Sans', id: 'f1' }],
  fontData: { f1: { data: 'AAEC', family: 'Test Sans' } },
}

const withFixtures = (note: string, calls: Call[], extra: Record<string, unknown> = {}): Case =>
  slidesCase(note, { slides: { fixtures: FIXTURES, ...extra } }, [OPEN_A, ...calls])

const trigger = (what: string, args: unknown[] = []): Call => ({
  channel: `d1/slides:${what}`,
  kind: 'trigger',
  name: `d1/slides:${what}`,
  args,
})
const para = (text: string) => [{ runs: [{ text }] }]
const pages = [0, 1, 2, 9]

const cases: Case[] = [
  withFixtures('notes, transitions, timing and header of the pages that have them', [
    ...pages.flatMap((n) => [
      call('slides:get-notes', [n]),
      call('slides:get-transition', [n]),
      call('slides:get-show-timing', [n]),
      call('slides:get-header-footer', [n]),
    ]),
  ]),
  withFixtures('animations are echoed for the shapes that are there, with their labels', [
    call('slides:get-animations', [0]),
    call('slides:get-animations', [1]),
    call('slides:get-animations', [9]),
    call('slides:get-shape-keys', [0]),
    call('slides:get-shape-keys', [1]),
  ]),
  withFixtures('links of an element, of a page and of its runs', [
    call('slides:get-link', [0, 'e1']),
    call('slides:get-link', [0, 'e2']),
    call('slides:get-link', [1, 'e1']),
    call('slides:get-link', [1, 'e3']),
    call('slides:get-link', ['1', 'e3']),
    call('slides:get-link', [9, 'e1']),
    call('slides:get-slide-links', [0]),
    call('slides:get-slide-links', [1]),
    call('slides:get-slide-links', [2]),
    call('slides:get-run-links', [0]),
    call('slides:get-run-links', [1]),
  ]),
  withFixtures('a link is set on top of the ones the deck has', [
    call('slides:set-link', [
      { slideIndex: 0, sourceId: 'e2', target: { kind: 'url', url: 'https://example.org/' } },
    ]),
    call('slides:get-link', [0, 'e2']),
    call('slides:set-link', [
      { slideIndex: 0, sourceId: 'nope', target: { kind: 'url', url: 'https://example.org/' } },
    ]),
  ]),
  withFixtures('chart data of a chart and of what is no chart', [
    call('slides:get-chart-data', [0, 'e1']),
    call('slides:get-chart-data', [0, 'e2']),
    call('slides:get-chart-data', [0, 'nope']),
    call('slides:get-chart-data', [9, 'e1']),
    call('slides:get-chart-data', [0, UNDEFINED]),
  ]),
  withFixtures('media and model data of the parts the deck holds', [
    call('slides:media-data', [0, 'e2']),
    call('slides:media-data', [1, 'e3']),
    call('slides:media-data', [0, 'e1']),
    call('slides:media-data', [1, 'e2']),
    call('slides:media-data', [9, 'e2']),
    call('slides:model3d-data', [0, 'e1']),
    call('slides:model3d-data', [0, 'e2']),
    call('slides:model3d-data', [1, 'e1']),
  ]),
  withFixtures('narration is cleared where it is, once', [
    call('slides:get-show-timing', [0]),
    call('slides:clear-narration', [[1]]),
    call('slides:clear-narration', [[0, 1]]),
    call('slides:get-show-timing', [0]),
    call('slides:clear-narration', [[0]]),
    call('slides:undo'),
    call('slides:get-show-timing', [0]),
    call('slides:clear-narration', [[]]),
  ]),
  withFixtures('slides of a section are removed with it, or none when it holds them all', [
    call('slides:remove-section-slides', [{ id: 's1' }]),
    call('slides:undo'),
    call('slides:remove-section-slides', [{ id: 's2' }]),
    call('slides:remove-section-slides', [{ id: 'nope' }]),
    call('slides:remove-section-slides', [{ id: null }]),
    call('slides:get-sections'),
  ]),
  withFixtures(
    'with no section the lead holds every slide and none is removed',
    [
      call('slides:remove-section-slides', [{ id: null }]),
      call('slides:remove-section-slides', [{ id: 's1' }]),
      call('slides:get-sections'),
    ],
    { fixtures: { ...FIXTURES, sections: [] } },
  ),
  withFixtures('the master part takes a fill and a stroke', [
    call('slides:master-enter', [1280]),
    call('slides:master-edit-fill', [{ sourceId: 'm0', fill: '#336699' }]),
    call('slides:master-edit-fill', [
      { sourceId: 'm0', fill: { gradient: { from: '#000000', to: '#ffffff', angleDeg: 90 } } },
    ]),
    call('slides:master-edit-fill', [
      {
        sourceId: 'm0',
        fill: {
          gradient: {
            from: '#000000',
            to: '#ffffff',
            stops: [
              { pos: 0, color: '#111111' },
              { pos: 1, color: '#eeeeee' },
            ],
            radial: true,
          },
        },
      },
    ]),
    call('slides:master-edit-fill', [{ sourceId: 'nope', fill: '#336699' }]),
    call('slides:master-edit-stroke', [
      { sourceId: 'm0', stroke: { color: '#112233', widthPt: 2 } },
    ]),
    call('slides:master-edit-stroke', [{ sourceId: 'm0', stroke: null }]),
    call('slides:master-edit-stroke', [{ sourceId: 'nope', stroke: null }]),
    call('slides:is-dirty'),
    call('slides:master-close'),
  ]),
  withFixtures('private fonts the app lists and hands over', [
    call('slides:private-font-faces'),
    call('slides:private-font-data', ['f1']),
    call('slides:private-font-data', ['f2']),
    call('slides:private-font-data', [UNDEFINED]),
    call('slides:private-font-data', [7]),
  ]),
  withFixtures('an edit script is mapped to ops and applied, refused, or empty', [
    call('slides:apply-edit-script', [
      { slideIndex: 0, steps: [{ op: 'setText', el: 'e1', paragraphs: para('Scripted') }] },
    ]),
    call('slides:get-render-slides'),
    call('slides:apply-edit-script', [
      { slideIndex: 0, steps: [{ op: 'setText', el: 'nope', paragraphs: para('x') }] },
    ]),
    call('slides:apply-edit-script', [
      {
        slideIndex: 0,
        steps: [
          { op: 'deleteElement', el: 'e1' },
          { op: 'setText', el: 'e1', paragraphs: para('gone') },
        ],
      },
    ]),
    call('slides:apply-edit-script', [{ slideIndex: 9, steps: [{ op: 'setHidden' }] }]),
    call('slides:apply-edit-script', [{ slideIndex: 0, steps: [] }]),
    call('slides:apply-edit-script', [{ slideIndex: 0 }]),
    call('slides:undo'),
    call('slides:get-render-slides'),
  ]),
  withFixtures(
    'the template of a deck says whether it holds a withheld element',
    [
      call('slides:template-bytes'),
      call('slides:set-element-hidden', [{ slideIndex: 0, sourceId: 'e2', hidden: true }]),
      call('slides:template-bytes'),
      call('slides:delete-element', [{ slideIndex: 0, sourceId: 'e2' }]),
      call('slides:template-bytes'),
    ],
    { fixtures: { ...FIXTURES, redact: { e2: 'confidential' } } },
  ),
  slidesCase('a tab queued a file for its renderer and the renderer takes it once', {}, [
    trigger('createSlidesView', ['$DIR/a.pptx']),
    call('slides:consume-pending-open', [1280]),
    call('slides:consume-pending-open', [640]),
  ]),
  slidesCase('a tab made for a file that is not there queues nothing', {}, [
    trigger('createSlidesView', ['$DIR/missing.pptx']),
    call('slides:consume-pending-open', [1280]),
  ]),
  slidesCase(
    'a pasted image is named after the clock',
    { slides: { clock: Date.UTC(2026, 10, 13, 9, 30, 15) } },
    [
      call('slides:files-add-pasted-image', [bin('png-bytes'), 'png']),
      call('slides:files-add-pasted-image', [bin('png-bytes'), 'PNG']),
      call('slides:files-add-pasted-image', [bin('jpeg-bytes'), 'jpg']),
      call('slides:files-add-pasted-image', [bin('data'), 'exe']),
      call('slides:files-add-pasted-image', [bin(''), 'png']),
    ],
  ),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  triggers: slidesTriggers,
  cases,
  single: {},
}
