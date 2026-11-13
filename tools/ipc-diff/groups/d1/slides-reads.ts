/**
 * Group `d1/slides-reads`: the slides editor's read queries, comments, links and
 * the deck-level reads (`apps/slides/src/main/slides-main.ts`), loaded as the
 * shell loads it (`d1/slides-host.ts`). The deck is the fake engine's
 * (`d1/slides-engine.ts`), opened by the case's own first call.
 *
 * The read channels of the fake deck answer the same fixed values on both
 * sides (no notes, no links, no animations): what is compared is the handlers'
 * argument checks, their missing-session and missing-slide answers, the comment
 * round trip through the executor and the history it leaves.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { NEW, OPEN_A, UNDEFINED, call, slidesCase } from '../../d1/slides-cases.ts'
import type { Call, Case, Group } from '../../types.ts'

const comment = (slideIndex: number, text: string) =>
  call('slides:add-comment', [{ slideIndex, text }])
const uncomment = (slideIndex: number, idx: number) =>
  call('slides:delete-comment', [{ slideIndex, authorId: 0, idx }])

/** a case that reads every query with the arguments given for slide `n` */
const reads = (n: unknown): Call[] => [
  call('slides:get-notes', [n]),
  call('slides:get-animations', [n]),
  call('slides:get-shape-keys', [n]),
  call('slides:get-show-timing', [n]),
  call('slides:get-transition', [n]),
  call('slides:get-header-footer', [n]),
  call('slides:get-link', [n, 'e1']),
  call('slides:get-slide-links', [n]),
  call('slides:get-run-links', [n]),
  call('slides:get-comments', [n]),
]

const cases: Case[] = [
  slidesCase('every query without a deck gives its empty answer', {}, [
    ...reads(0),
    call('slides:get-all-comments'),
    call('slides:get-slide-size'),
    call('slides:is-dirty'),
    comment(0, 'x'),
    uncomment(0, 0),
  ]),
  slidesCase('every query of an opened deck, on a slide and past the end', {}, [
    OPEN_A,
    ...reads(0),
    ...reads(1),
    ...reads(2),
    ...reads(7),
    call('slides:get-all-comments'),
    call('slides:get-slide-size'),
  ]),
  slidesCase('queries with arguments that are no slide numbers', {}, [
    OPEN_A,
    ...reads(-1),
    ...reads('1'),
    ...reads(1.5),
    ...reads(UNDEFINED),
    call('slides:get-link', [0, UNDEFINED]),
    call('slides:get-link'),
  ]),
  slidesCase('a comment is added, listed and deleted', {}, [
    OPEN_A,
    comment(0, 'first'),
    comment(0, 'second'),
    comment(1, 'other page'),
    call('slides:get-comments', [0]),
    call('slides:get-all-comments'),
    call('slides:is-dirty'),
    uncomment(0, 0),
    call('slides:get-all-comments'),
  ]),
  slidesCase('comments that cannot be added or deleted leave no history', {}, [
    OPEN_A,
    comment(9, 'nowhere'),
    uncomment(0, 3),
    uncomment(9, 0),
    comment(-1, 'before'),
    call('slides:undo'),
    call('slides:is-dirty'),
  ]),
  slidesCase('a comment is one undo step and undone it is gone', {}, [
    OPEN_A,
    comment(0, 'to undo'),
    call('slides:undo'),
    call('slides:get-comments', [0]),
    call('slides:redo'),
    call('slides:get-comments', [0]),
  ]),
  slidesCase('the comment author is the configured name or the account', {}, [
    OPEN_A,
    comment(0, 'by Ann'),
  ], { files: { 'userData/app-settings.json': '{"authorName":"  Bo   Lee "}' } }),
  slidesCase('a link is set, refused or cleared', {}, [
    OPEN_A,
    call('slides:set-link', [{ slideIndex: 0, sourceId: 'e1', target: { kind: 'url', url: 'https://example.com/a' } }]),
    call('slides:set-link', [{ slideIndex: 0, sourceId: 'e1', target: { kind: 'url', url: 'javascript:alert(1)' } }]),
    call('slides:set-link', [{ slideIndex: 0, sourceId: 'e1', target: { kind: 'url', url: 'mailto:a@b.c' } }]),
    call('slides:set-link', [{ slideIndex: 0, sourceId: 'e1', target: { kind: 'url', url: 'file:///etc/passwd' } }]),
    call('slides:set-link', [{ slideIndex: 0, sourceId: 'e1', target: null }]),
    call('slides:set-link', [{ slideIndex: 0, sourceId: 'e1', target: { kind: 'slide', slideIndex: 1 } }]),
  ]),
  slidesCase('a new blank deck is queried', { blankSlides: 2 }, [
    NEW,
    call('slides:get-slide-size'),
    call('slides:get-render-slides'),
    call('slides:get-sections'),
    call('slides:is-dirty'),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:get-notes': 'the fake deck has no notes: the one answer is the empty text (the missing-slide answer is the same)',
    'slides:get-animations': 'the fake deck has no animations',
    'slides:get-header-footer': 'the fake deck has no header or footer: one fixed answer',
    'slides:get-link': 'the fake deck has no links, and a missing deck answers the same',
    'slides:get-slide-links': 'the fake deck has no links',
    'slides:get-run-links': 'the fake deck has no links',
    'slides:get-transition': 'the fake deck has no transitions: the answer is none',
    'slides:get-show-timing': 'the fake deck has no timing',
  },
}
