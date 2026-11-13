/**
 * Group `d1/slides-export`: exporting a deck: the folder and file pickers, the
 * images, the single picture, the PDF and the headless export handshake
 * (`apps/slides/src/main/slides-main.ts`), loaded as the shell loads it
 * (`d1/slides-host.ts`). The hidden window that prints a PDF is the shell's: the
 * fake `exportSlidesPdf` logs the path, writes `%PDF-1.7` there and reports it, on
 * both sides.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { OPEN_A, UNDEFINED, call, send, slidesCase } from '../../d1/slides-cases.ts'
import type { Case, Group } from '../../types.ts'

const PNGS = ['AAEC', 'AwQF', 'BgcI']
const images = (extra: Record<string, unknown> = {}) =>
  call('slides:export-images', [{ dir: '$DIR/img', baseName: 'slide', pngsBase64: PNGS, ...extra }])
const pdf = (extra: Record<string, unknown> = {}) =>
  call('slides:export-pdf', [{ filePath: '$DIR/out.pdf', pages: [], widthPx: 1280, heightPx: 720, ...extra }])

const cases: Case[] = [
  slidesCase('the folder picker answers a folder or null', { opens: [['$DIR/img'], null, []] }, [
    call('slides:pick-export-dir'),
    call('slides:pick-export-dir'),
    call('slides:pick-export-dir'),
  ]),
  slidesCase('the PDF path picker answers a path or null', { saves: ['$DIR/deck.pdf', null, ''] }, [
    call('slides:pick-export-pdf-path', ['Deck.pdf']),
    call('slides:pick-export-pdf-path', ['Deck.pdf']),
    call('slides:pick-export-pdf-path', [UNDEFINED]),
  ]),
  slidesCase('a picture is saved where the dialog says', { saves: ['$DIR/pic.png', null] }, [
    call('slides:save-picture', [{ pngBase64: 'AAEC', defaultName: 'Picture 1' }]),
    call('slides:save-picture', [{ pngBase64: 'AAEC', defaultName: 'Picture 1' }]),
  ]),
  slidesCase('a picture that cannot be written reports the error', { saves: ['$DIR/dir.pptx'] }, [
    call('slides:save-picture', [{ pngBase64: 'AAEC', defaultName: 'Picture 1' }]),
  ]),
  slidesCase('images are written one file per slide', {}, [
    images(),
    images({ format: 'jpg', baseName: 'photo' }),
    images({ format: 'gif', dir: '$DIR/gif' }),
    images({ pngsBase64: ['AAEC'], baseName: 'one' }),
    images({ pngsBase64: [] }),
  ], { files: { 'img/.keep': '' } }),
  slidesCase('images into a folder that is not there fail', {}, [
    images({ dir: '$DIR/missing/deeper' }),
    images({ dir: '$DIR/a.pptx' }),
  ]),
  slidesCase('a Save As png name authorizes one image export', { saves: ['$DIR/page.png'] }, [
    OPEN_A,
    images({ saveAsTarget: '$DIR/page.png' }),
    call('slides:save-as', ['Deck.pptx']),
    images({ saveAsTarget: '$DIR/other.png' }),
    images({ saveAsTarget: '$DIR/page.png', format: 'jpg' }),
    images({ saveAsTarget: '$DIR/page.png' }),
    images({ saveAsTarget: '$DIR/page.png' }),
  ]),
  slidesCase('the PDF is exported by the shell and revealed', {}, [
    pdf(),
    pdf({ filePath: '$DIR/second.pdf' }),
    pdf({ filePath: UNDEFINED }),
  ]),
  slidesCase('the question before a PDF or image copy of a marked deck', { messages: [{ response: 0 }, { response: 1 }, { response: 2 }, { response: 9 }, { response: 1 }] }, [
    call('slides:ask-withheld-export', ['PDF']),
    call('slides:ask-withheld-export', ['JPG']),
    call('slides:ask-withheld-export', ['PNG']),
    call('slides:ask-withheld-export', ['PDF']),
    call('slides:ask-withheld-export', ['PNG']),
  ]),
  slidesCase('a format the question does not offer is refused before any dialog', { messages: [{ response: 0 }] }, [
    call('slides:ask-withheld-export', ['DOCX']),
    call('slides:ask-withheld-export', ['pdf']),
    call('slides:ask-withheld-export', [UNDEFINED]),
    call('slides:ask-withheld-export'),
    call('slides:ask-withheld-export', ['JPG']),
  ]),
  slidesCase('the headless export target is handed over once', {}, [
    call('slides:consume-headless-export'),
    call('slides:consume-headless-export'),
    send('slides:headless-export-done', [{ ok: true }]),
    send('slides:headless-export-done', [{ ok: false, error: 'boom' }]),
    send('slides:headless-export-done', [null]),
    send('slides:headless-export-done', []),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:headless-export-done': 'a send that answers nothing; only a headless export has a waiter to settle',
  },
}
