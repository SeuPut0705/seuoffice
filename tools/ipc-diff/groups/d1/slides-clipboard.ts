/**
 * Group `d1/slides-clipboard`: the in-app slide and element clipboards, the
 * system clipboard probes and the native cut/copy/paste of the focused page
 * (`apps/slides/src/main/slides-main.ts`, `element-clipboard.ts`,
 * `paste-cascade.ts`), loaded as the shell loads it (`d1/slides-host.ts`). The
 * clipboard's custom formats (the markers that say the in-app copy is still what
 * the system clipboard holds) live in the fake desktop; the shared hosts answer
 * `clipboard.readText`, `readImage` and `availableFormats` from the case.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { OPEN_A, UNDEFINED, call, slidesCase, view } from '../../d1/slides-cases.ts'
import type { Case, Group } from '../../types.ts'

const copyEls = (extra: Record<string, unknown> = {}) =>
  call('slides:copy-elements', [
    { slideIndex: 0, sourceIds: ['e1', 'e2'], clipboardToken: 'tok-1', ...extra },
  ])
const pasteEls = (extra: Record<string, unknown> = {}) =>
  call('slides:paste-elements', [{ slideIndex: 0, fitWidthPx: 1280, ...extra }])
const copySlides = (extra: Record<string, unknown> = {}) =>
  call('slides:copy-slides', [{ slideIndexes: [0, 1], ...extra }])
const pasteSlide = (extra: Record<string, unknown> = {}) =>
  call('slides:paste-slide', [{ afterIndex: 0, fitWidthPx: 1280, ...extra }])

const cases: Case[] = [
  slidesCase('every clipboard channel without a deck', {}, [
    call('slides:has-slide-clipboard'),
    copySlides(),
    pasteSlide(),
    call('slides:repaste-slide', [{ mode: 'keep', fitWidthPx: 1280 }]),
    copyEls(),
    pasteEls(),
    call('slides:duplicate-elements', [
      { slideIndex: 0, sourceIds: ['e1'], dxPx: 10, dyPx: 10, fitWidthPx: 1280 },
    ]),
    call('slides:copy-elements-image', ['tok-1', 'AAEC']),
    call('slides:clipboard-external'),
    call('slides:clipboard-probe'),
  ]),
  slidesCase('slides are copied and pasted, again with another mode', {}, [
    OPEN_A,
    call('slides:has-slide-clipboard'),
    copySlides({ pngs: ['AAEC', 'AwQF'] }),
    call('slides:has-slide-clipboard'),
    pasteSlide(),
    pasteSlide({ afterIndex: 1, mode: 'picture' }),
    call('slides:repaste-slide', [{ mode: 'keep', fitWidthPx: 1280 }]),
    call('slides:repaste-slide', [{ mode: 'picture', fitWidthPx: 800 }]),
    call('slides:is-dirty'),
    call('slides:undo'),
    call('slides:repaste-slide', [{ mode: 'keep', fitWidthPx: 1280 }]),
  ]),
  slidesCase('slides that cannot be copied or pasted', {}, [
    OPEN_A,
    pasteSlide(),
    call('slides:copy-slides', [{ slideIndexes: [] }]),
    call('slides:copy-slides', [{ slideIndexes: [9] }]),
    call('slides:copy-slides', [{ slideIndexes: [0, 9] }]),
    pasteSlide({ afterIndex: 9 }),
    pasteSlide({ afterIndex: -1 }),
    call('slides:repaste-slide', [{ mode: 'keep', fitWidthPx: 1280 }]),
  ]),
  slidesCase(
    'a slide copied in one window is pasted into the other',
    {},
    [
      call('slides:open-path', ['$DIR/a.pptx', 1280]),
      call('slides:open-path', ['$DIR/b.pptx', 1280], { view: 2 }),
      copySlides({ slideIndexes: [0] }),
      call('slides:paste-slide', [{ afterIndex: 0, fitWidthPx: 1000 }], { view: 2 }),
      call('slides:get-render-slides', [], { view: 2 }),
      call('slides:has-slide-clipboard', [], { view: 2 }),
    ],
    { views: [view(1), view(2)] },
  ),
  slidesCase('elements are copied, cut, pasted with a cascade and duplicated', {}, [
    OPEN_A,
    copyEls(),
    pasteEls(),
    pasteEls(),
    pasteEls({ slideIndex: 1 }),
    copyEls({ cut: true, sourceIds: ['e1'] }),
    pasteEls(),
    call('slides:duplicate-elements', [
      { slideIndex: 0, sourceIds: ['e1', 'e2'], dxPx: 10, dyPx: 10, fitWidthPx: 1280 },
    ]),
    call('slides:duplicate-elements', [
      { slideIndex: 0, sourceIds: ['nope'], dxPx: 10, dyPx: 10, fitWidthPx: 1280 },
    ]),
    call('slides:duplicate-elements', [
      { slideIndex: 9, sourceIds: ['e1'], dxPx: 10, dyPx: 10, fitWidthPx: 1280 },
    ]),
    call('slides:is-dirty'),
  ]),
  slidesCase('elements that cannot be copied or pasted', {}, [
    OPEN_A,
    pasteEls(),
    copyEls({ slideIndex: 9 }),
    copyEls({ sourceIds: [] }),
    copyEls({ sourceIds: ['nope'] }),
    pasteEls({ slideIndex: 9 }),
    copyEls({ clipboardToken: UNDEFINED }),
    pasteEls(),
  ]),
  slidesCase(
    'the element clipboard image is written only for the token that copied',
    {},
    [
      OPEN_A,
      call('slides:copy-elements-image', ['tok-1', 'AAEC']),
      copyEls(),
      call('slides:copy-elements-image', ['tok-1', 'AAEC']),
      call('slides:copy-elements-image', ['other', 'AAEC']),
      call('slides:copy-elements-image', ['tok-1', '']),
      call('slides:copy-elements-image', ['tok-1', 'AAEC'], { view: 2 }),
    ],
    { views: [view(1), view(2)] },
  ),
  slidesCase(
    'the system clipboard holds text',
    { shared: { clipboard: { text: '  some words  ' } } },
    [call('slides:clipboard-probe'), call('slides:clipboard-external')],
  ),
  slidesCase(
    'the system clipboard holds an image',
    { shared: { clipboard: { imagePng: '89504e470d0a1a0a', formats: ['image/png'] } } },
    [call('slides:clipboard-probe'), call('slides:clipboard-external')],
  ),
  slidesCase(
    'the system clipboard holds html only',
    { shared: { clipboard: { html: '<b>x</b>', text: '' } } },
    [call('slides:clipboard-probe'), call('slides:clipboard-external')],
  ),
  slidesCase('the system clipboard is empty', {}, [
    call('slides:clipboard-probe'),
    call('slides:clipboard-external'),
  ]),
  slidesCase(
    'the in-app copy is still what the system clipboard holds',
    { shared: { clipboard: { text: 'other text' } } },
    [
      OPEN_A,
      copySlides(),
      call('slides:clipboard-probe'),
      call('slides:clipboard-external'),
      copyEls(),
      call('slides:clipboard-probe'),
      call('slides:clipboard-external'),
    ],
  ),
  slidesCase("the page's own cut, copy and paste", {}, [
    call('slides:native-clipboard', ['cut']),
    call('slides:native-clipboard', ['copy']),
    call('slides:native-clipboard', ['paste']),
    call('slides:native-clipboard', ['anything']),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:native-clipboard': "answers nothing; the page's cut, copy or paste is the logged call",
  },
}
