/**
 * Group `d1/slides-lifecycle`: opening, creating, saving and closing a deck, the
 * recent list, dirty tracking and the autosave preference
 * (`apps/slides/src/main/slides-main.ts`), loaded as the shell loads it
 * (`d1/slides-host.ts`, the fake deck of `d1/slides-engine.ts`).
 *
 * A save writes the fake deck's file form, so the folder after the case is part of
 * the comparison. The timers (the 30 s recovery pass, the 120 s close-save timeout)
 * are not waited for: the recovery pass is driven by `slides:save` and the close
 * request by the shell's `requestSlidesClose`, which no call reaches.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { DECK, NEW, OPEN_A, UNDEFINED, call, deck, send, slidesCase, view } from '../../d1/slides-cases.ts'
import type { Case, Group } from '../../types.ts'

const hide = call('slides:set-hidden', [{ slideIndex: 0, hidden: true }])
const open = (path: string, fit: unknown = 1280) => call('slides:open-path', [path, fit])
const closeSaved = (ok: unknown) => send('slides:close-save-result', [ok])

const cases: Case[] = [
  slidesCase('a blank deck, with and without the renderer\'s default size', { slides: { blankSlides: 2 } }, [
    NEW,
    call('slides:new-blank', [800, { cx: 12192000, cy: 6858000 }]),
    call('slides:new-blank', [800, { cx: 100, cy: 6858000 }]),
    call('slides:new-blank', [800, { cx: 12192000.5, cy: 6858000 }]),
    call('slides:new-blank', [800, 'wide']),
    call('slides:get-slide-size'),
    call('slides:is-dirty'),
  ]),
  slidesCase('a deck is opened by its path', {}, [
    open('$DIR/a.pptx'),
    open('$DIR/a.pptx', 640),
    open('$DIR/b.pptx'),
    open('$DIR/missing.pptx'),
    open(''),
    open('$DIR/bad.pptx'),
    open('$DIR/dir.pptx'),
    open('$DIR/empty.pptx'),
    call('slides:recent'),
  ]),
  slidesCase('a second window opens the deck the first has open', {}, [
    call('slides:open-path', ['$DIR/a.pptx', 1280]),
    call('slides:open-path', ['$DIR/a.pptx', 900], { view: 2 }),
    call('slides:get-render-slides', [], { view: 2 }),
    call('slides:is-dirty', [], { view: 2 }),
    hide,
    call('slides:is-dirty', [], { view: 2 }),
    call('slides:recent'),
  ], { views: [view(1), view(2)] }),
  slidesCase('the open dialog is answered, cancelled or answers a missing file', { opens: [['$DIR/a.pptx'], null, ['$DIR/missing.pptx'], []] }, [
    call('slides:open', [1280]),
    call('slides:open', [1280]),
    call('slides:open', [1280]),
    call('slides:open', [1280]),
    call('slides:recent'),
  ]),
  slidesCase('nothing is queued for a window that was not asked to open a path', {}, [
    call('slides:consume-pending-open', [1280]),
    call('slides:consume-pending-open', [UNDEFINED]),
  ]),
  slidesCase('a deck with changes is saved to its path', { }, [
    OPEN_A,
    call('slides:save'),
    hide,
    call('slides:is-dirty'),
    call('slides:save'),
    call('slides:is-dirty'),
    call('slides:save', [true]),
    call('slides:save', ['auto']),
  ]),
  slidesCase('an untitled deck asks where to save, and the answer is cancelled once', { saves: [null, '$DIR/new.pptx'] }, [
    NEW,
    hide,
    call('slides:save'),
    call('slides:save'),
    call('slides:is-dirty'),
    call('slides:recent'),
  ]),
  slidesCase('save as writes a new file and moves the deck there', { saves: ['$DIR/copy.pptx', null, '$DIR/other.pptx'] }, [
    OPEN_A,
    hide,
    call('slides:save-as', ['Deck.pptx']),
    call('slides:save-as', ['Deck.pptx']),
    call('slides:save-as', [UNDEFINED]),
    call('slides:is-dirty'),
    call('slides:save'),
    call('slides:recent'),
  ]),
  // a failed write names its random temporary file, which no case can compare
  slidesCase('save as to a copy format only reports what the renderer must export', { saves: ['$DIR/page.pdf', '$DIR/slide.png', '$DIR/Slide.PNG', '$DIR/deck'] }, [
    OPEN_A,
    hide,
    call('slides:save-as', ['Deck.pptx']),
    call('slides:save-as', ['Deck.pptx']),
    call('slides:save-as', ['Deck.pptx']),
    call('slides:save-as', ['Deck.pptx']),
    call('slides:is-dirty'),
    call('slides:recent'),
  ]),
  slidesCase('nothing saves without a deck', { saves: ['$DIR/none.pptx'] }, [
    call('slides:save'),
    call('slides:save-as', ['Deck.pptx']),
    call('slides:save-into-project'),
    call('slides:is-dirty'),
  ]),
  slidesCase('save into the project folder of the view', { slides: { projectDir: '$DIR' } }, [
    NEW,
    hide,
    call('slides:save-into-project'),
    call('slides:save-into-project'),
    call('slides:is-dirty'),
  ]),
  slidesCase('the autosave preference and a close answer nobody asked for are taken', {}, [
    OPEN_A,
    send('slides:autosave-pref', [true]),
    send('slides:autosave-pref', ['yes']),
    closeSaved(true),
    closeSaved('no'),
    closeSaved(UNDEFINED),
    call('slides:is-dirty'),
  ]),
  slidesCase('a saved deck keeps the encoding it was opened with', {}, [
    open('$DIR/a.pptx'),
    hide,
    call('slides:save'),
  ], { files: { 'a.pptx': deck('e1=A', 'e2=B') } }),
  slidesCase('the default deck file opens', {}, [open('$DIR/a.pptx'), call('slides:get-render-slides')], { files: { 'a.pptx': DECK } }),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:autosave-pref': 'a send that answers nothing; its effect is the preference the autosave reads',
    'slides:close-save-result': 'a send that answers nothing; it settles a close request no call makes',
    'slides:consume-pending-open': 'no path is queued for a view the shell did not ask to open one: the answer is null',
  },
}
