/**
 * Group `d1/slides-presenter`: the presenter view and the show fullscreen, the
 * attachment files, the generate hand-off and the generated pages, the template
 * channels, the local fonts and the narration microphone
 * (`apps/slides/src/main/slides-main.ts`, `presenter-show.ts`, `attachments-ipc.ts`,
 * `generate-handoff-ipc.ts`, `template-bytes.ts`, `template-cover.ts`), loaded as
 * the shell loads it (`d1/slides-host.ts`, the desktop of `d1/slides-desktop.ts`).
 * The audience window is view and window 100; every random UUID counts up.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { OPEN_A, UNDEFINED, bin, call, deck, send, slidesCase, view } from '../../d1/slides-cases.ts'
import type { Case, Group } from '../../types.ts'

const TWO = { views: [view(1), view(100)] }
const SYNC = { slide: 1, step: 2 }
const CLOCK = Date.UTC(2026, 10, 13, 9, 30, 15)

const cases: Case[] = [
  slidesCase('a presenter view with one display has no audience', {}, [
    OPEN_A,
    call('slides:presenter-start'),
    call('slides:presenter-start'),
    send('slides:presenter-sync', [SYNC]),
    call('slides:presenter-swap'),
    call('slides:presenter-end'),
    call('slides:presenter-end'),
  ]),
  slidesCase('with an external display the audience window opens, follows and swaps', { slides: { externalDisplay: true } }, [
    OPEN_A,
    call('slides:presenter-start'),
    call('slides:presenter-start'),
    send('slides:presenter-sync', [SYNC]),
    call('slides:audience-ready', [], { view: 100 }),
    send('slides:audience-nav', ['next'], 100),
    send('slides:presenter-ink', [{ kind: 'stroke' }]),
    call('slides:get-render-slides', [], { view: 100 }),
    call('slides:presenter-swap'),
    call('slides:presenter-end'),
    call('slides:audience-ready', [], { view: 100 }),
  ], TWO),
  slidesCase('without a deck there is no audience, and no sync to hand over', { slides: { externalDisplay: true } }, [
    call('slides:presenter-start'),
    call('slides:audience-ready'),
    send('slides:audience-nav', ['prev']),
    send('slides:presenter-sync', [SYNC]),
    call('slides:presenter-swap'),
  ], TWO),
  slidesCase('the show goes fullscreen and leaves it after the debounce', {}, [
    call('slides:show-fullscreen', [true]),
    call('slides:show-fullscreen', [true]),
    call('slides:show-fullscreen', [false]),
    call('slides:show-fullscreen', [false]),
    call('slides:show-fullscreen', [UNDEFINED]),
  ]),
  slidesCase('the microphone is asked once, granted or refused', {}, [
    call('slides:microphone-access'),
    OPEN_A,
    call('slides:microphone-access'),
    send('slides:microphone-release'),
  ]),
  slidesCase('the microphone is refused by the system', { slides: { microphone: false } }, [
    OPEN_A,
    call('slides:microphone-access'),
    call('slides:microphone-access'),
  ]),
  slidesCase('attachments are checked, picked and read', { opens: [['$DIR/note.txt', '$DIR/pic.png'], null] }, [
    call('slides:files-add', [['$DIR/note.txt', '$DIR/pic.png', '$DIR/missing.txt', '$DIR/dir.pptx', '$DIR/x.bin']]),
    call('slides:files-pick'),
    call('slides:files-pick'),
    call('slides:files-read', ['$DIR/note.txt', 0, 5]),
    call('slides:files-read', ['$DIR/note.txt', 3.7, 0]),
    call('slides:files-read', ['$DIR/missing.txt', 0, 10]),
    call('slides:files-read', ['$DIR/pic.png', 0, 10]),
    call('slides:files-read', ['$DIR/x.bin', 0, 10]),
    call('slides:files-read-image', ['$DIR/pic.png']),
    call('slides:files-read-image', ['$DIR/note.txt']),
    call('slides:files-read-image', ['$DIR/missing.png']),
  ], { files: { 'note.txt': 'hello attachments', 'pic.png': 'png-bytes', 'x.bin': 'xx' } }),
  // a saved paste is named after the clock (`pasted-<stamp>-n.png`), which the Rust side reads from the system
  slidesCase('a pasted image that is no image or no data is refused', {}, [
    call('slides:files-add-pasted-image', [bin('data'), 'exe']),
    call('slides:files-add-pasted-image', [bin(''), 'png']),
    call('slides:files-add-pasted-image', ['text', 'png']),
    call('slides:files-add-pasted-image', [bin('big'), UNDEFINED]),
  ]),
  slidesCase('the generate hand-off is taken once and a run reported', { slides: { handoff: { id: 'h1', text: 'make a deck', materials: [{ path: '$DIR/a.pptx', name: 'a.pptx' }] } } }, [
    call('slides:handoff-take'),
    call('slides:handoff-take'),
    call('slides:handoff-run-started', [['$DIR/a.pptx']]),
    call('slides:handoff-run-started', [[]]),
    call('slides:handoff-run-started', [['', 5]]),
    call('slides:handoff-run-started', ['x']),
  ]),
  slidesCase('a page is generated from a spec and landed', { slides: { blankSlides: 1 } }, [
    call('slides:local-page-generate', [{ specJson: '{"layout":"title"}' }]),
    call('slides:local-page-generate', [{ specJson: '' }]),
    call('slides:local-page-generate', [{}]),
  ]),
  slidesCase('generated pages are refused unless issued', {}, [
    call('slides:land-generated-pages', [['cloudpptx:/nowhere.pptx'], 1280]),
    call('slides:land-generated-pages', [['plain'], 1280]),
    call('slides:land-generated-pages', [['plain'], 1280, 'append']),
    call('slides:land-generated-pages', [['plain'], 1280, 'replace_at', 0]),
  ]),
  slidesCase('a template cover is rendered for a catalog id and a language', {}, [
    call('slides:template-cover-render', ['plain', 'en']),
    call('slides:template-cover-render', ['plain', 'ko']),
    call('slides:template-cover-render', ['plain', 'fr']),
    call('slides:template-cover-render', ['nope', 'en']),
    call('slides:template-cover-render', [UNDEFINED, 'en']),
  ]),
  slidesCase('the open deck is handed over as a template', {}, [
    call('slides:template-bytes'),
    OPEN_A,
    call('slides:template-bytes'),
  ]),
  slidesCase('local fonts are installed or declined', { opens: [['$DIR/A.ttf', '$DIR/b.otf'], null, []] }, [
    call('slides:font-install-local'),
    call('slides:font-install-local'),
    call('slides:font-install-local'),
    call('slides:private-font-faces'),
    call('slides:private-font-data', ['id-1']),
    call('slides:private-font-data', [UNDEFINED]),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:template-bytes': 'one answer per deck state is all there is',
    'slides:audience-nav': 'a send that answers nothing; the forwarded event is compared',
    'slides:presenter-sync': 'a send that answers nothing; the forwarded event is compared',
    'slides:presenter-ink': 'a send that answers nothing; the forwarded event is compared',
    'slides:files-add': 'the answer lists accepted and rejected files of the case\'s folder',
    'slides:files-add-pasted-image': 'the saved name is made from the clock, so only refusals are compared',
    'slides:private-font-data': 'the fake font store holds no face: the answer is null',
    'slides:show-fullscreen': 'answers nothing; the snap and the bleed are the logged calls',
  },
}

void deck
