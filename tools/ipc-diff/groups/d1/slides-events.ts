/**
 * Group `d1/slides-events`: the events no channel call reaches, through the
 * triggers the shell runs on the editor (`d1/slides-host.ts` `slidesTriggers`,
 * `probe_trigger` of crates/shell-ipc/d1/src/slides/mod.rs):
 *
 * - `slides:close-save-request`: `requestSlidesClose` asks the renderer to run
 *   its save flow; the renderer's `slides:close-save-result` answers it, so the
 *   close is deferred and awaited on its full path;
 * - `slides:menu`: the File menu's Save As and export items, clicked;
 * - `slides:opened`: `createSlidesWindow(path)` opening its deck once the page loaded.
 */
import { loadSlides, slidesTriggers } from '../../d1/slides-host.ts'
import { OPEN_A, call, send, slidesCase } from '../../d1/slides-cases.ts'
import type { Call, Case, Group } from '../../types.ts'

const trigger = (what: string, args: unknown[] = [], defer = false): Call => ({
  channel: `d1/slides:${what}`,
  kind: 'trigger',
  name: `d1/slides:${what}`,
  args,
  ...(defer ? { defer: true as const } : {}),
})
const settle = (index: number): Call => ({ channel: '', args: [], await: index })
const hide = call('slides:set-hidden', [{ slideIndex: 0, hidden: true }])
const close = (withParent = false) => trigger('requestSlidesClose', [withParent], true)

const cases: Case[] = [
  slidesCase('a clean deck closes without asking', {}, [
    OPEN_A,
    trigger('requestSlidesClose', [false]),
    trigger('requestSlidesClose', [true]),
  ]),
  slidesCase(
    'Save asks the renderer to save and waits for its answer',
    { messages: [{ response: 0 }] },
    [OPEN_A, hide, close(), send('slides:close-save-result', [true]), settle(3)],
  ),
  slidesCase(
    'a save the renderer reports as failed keeps the tab open',
    { messages: [{ response: 0 }] },
    [OPEN_A, hide, close(true), send('slides:close-save-result', [false]), settle(3)],
  ),
  slidesCase(
    "Don't Save and Cancel ask nothing of the renderer",
    { messages: [{ response: 1 }, { response: 2 }] },
    [OPEN_A, hide, trigger('requestSlidesClose', [false]), trigger('requestSlidesClose', [false])],
  ),
  slidesCase(
    'autosave saves a deck with a path silently, and falls back to the dialog on failure',
    { messages: [{ response: 1 }] },
    [
      OPEN_A,
      send('slides:autosave-pref', [true]),
      hide,
      close(),
      send('slides:close-save-result', [true]),
      settle(4),
      close(),
      send('slides:close-save-result', [false]),
      settle(7),
    ],
  ),
  slidesCase(
    'a deck shared by two windows closes one without asking',
    {},
    [
      call('slides:open-path', ['$DIR/a.pptx', 1280]),
      { ...call('slides:open-path', ['$DIR/a.pptx', 1280]), view: 2 },
      hide,
      trigger('requestSlidesClose', [false]),
    ],
    {
      views: [
        { view: 1, window: 1, surface: 'Slides' },
        { view: 2, window: 2, surface: 'Slides' },
      ],
    },
  ),
  slidesCase('the File menu sends its Save As and export commands to the active view', {}, [
    OPEN_A,
    trigger('slidesMenu', ['save-as']),
    trigger('slidesMenu', ['export-pdf']),
    trigger('slidesMenu', ['export-images']),
    trigger('slidesMenu', ['export-images-jpg']),
  ]),
  // the TypeScript's click sends `slides:menu` and waits for nothing; the Rust request also waits
  // for the renderer's Save As to resume (a unit test reads what it resumes with), and the
  // renderer-visible answers and events of that Save As must stay what they are
  slidesCase(
    "the renderer answers the menu's Save As with its own save-as call",
    { saves: [null, '$DIR/menu.pptx', '$DIR/menu.pdf'] },
    [
      OPEN_A,
      call('slides:set-hidden', [{ slideIndex: 0, hidden: true }]),
      trigger('slidesMenu', ['save-as']),
      call('slides:save-as', ['Deck.pptx']),
      trigger('slidesMenu', ['save-as']),
      trigger('slidesMenu', ['save-as']),
      call('slides:save-as', ['Deck.pptx']),
      call('slides:is-dirty'),
      trigger('slidesMenu', ['save-as']),
      call('slides:save-as', ['Deck.pptx']),
      call('slides:recent'),
    ],
  ),
  slidesCase('a window made for a file opens it and tells its page', {}, [
    trigger('openFileInWindow', ['$DIR/a.pptx']),
    call('slides:is-dirty'),
    call('slides:recent'),
  ]),
  // a listener added with `once` stays in the fake emitter, so each case makes one window
  slidesCase('a window made for a file that is not a deck says nothing', {}, [
    trigger('openFileInWindow', ['$DIR/bad.pptx']),
    call('slides:recent'),
  ]),
  slidesCase('a window made for a file that is gone says nothing', {}, [
    trigger('openFileInWindow', ['$DIR/missing.pptx']),
    call('slides:recent'),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  triggers: slidesTriggers,
  cases,
  single: {},
}
