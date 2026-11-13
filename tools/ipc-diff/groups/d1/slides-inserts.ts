/**
 * Group `d1/slides-inserts`: pictures, backgrounds, media, 3D models, ink,
 * narration recordings and the slide/section moves that need a file or a dialog
 * (`apps/slides/src/main/slides-main.ts`), loaded as the shell loads it
 * (`d1/slides-host.ts`). Every picture of the fake desktop is 640x480 and the
 * deck's executor makes an element for `addPicture`; the dialogs answer from the
 * case's `opens` list.
 */
import { loadSlides } from '../../d1/slides-host.ts'
import { OPEN_A, UNDEFINED, bin, call, slidesCase } from '../../d1/slides-cases.ts'
import type { Call, Case, Group } from '../../types.ts'

const FILES = {
  'pic.png': 'png-bytes',
  'pic.JPG': 'jpg-bytes',
  'pic.tif': 'tif-bytes',
  'empty.png': '',
  'clip.mp4': 'mp4-bytes',
  'song.mp3': 'mp3-bytes',
  'clip.avi': 'avi-bytes',
  'model.glb': 'glb-bytes',
}
const box = { xPx: 10, yPx: 20, wPx: 100, hPx: 50, fitWidthPx: 1280 }
const glb = () => bin('glb-bytes')

const run = (note: string, host: Parameters<typeof slidesCase>[1], calls: Call[]): Case =>
  slidesCase(note, host, calls, { files: FILES })

const cases: Case[] = [
  run(
    'every insert channel without a deck answers null',
    { opens: [['$DIR/pic.png'], ['$DIR/pic.png']] },
    [
      call('slides:insert-image', [0, 1280]),
      call('slides:insert-media', [0, 'video', 1280]),
      call('slides:add-media-bytes', [
        { slideIndex: 0, kind: 'video', base64: 'AAEC', ext: 'mp4', name: 'v', ...box },
      ]),
      call('slides:add-model3d', [
        { slideIndex: 0, bytes: UNDEFINED, name: 'm', aspect: 1, fitWidthPx: 1280 },
      ]),
      call('slides:set-model3d-view', [
        { slideIndex: 0, sourceId: 'e1', rot: { ax: 0, ay: 0, az: 0 } },
      ]),
      call('slides:add-ink', [{ slideIndex: 0, base64: 'AAEC', payload: '{}', ...box }]),
      call('slides:add-image-bytes', [{ slideIndex: 0, base64: 'AAEC', ext: 'png', ...box }]),
      call('slides:replace-picture-bytes', [
        { slideIndex: 0, sourceId: 'e1', base64: 'AAEC', ext: 'png' },
      ]),
      call('slides:save-recording', [
        { slides: [{ slideIndex: 0, wavBase64: 'AAEC', durationMs: 1, advanceMs: 1 }] },
      ]),
      call('slides:clear-narration', [[0]]),
      call('slides:move-slides', [{ slideIndexes: [0], insertAt: 1 }]),
      call('slides:remove-section-slides', [{ id: null }]),
      call('slides:edit-background', [
        { slideIndex: 0, kind: 'solid', color: '#ff0000', fitWidthPx: 1280 },
      ]),
      call('slides:edit-image-fill', [
        { slideIndex: 0, targets: [{ sourceId: 'e1' }], mode: 'stretch' },
      ]),
    ],
  ),
  run(
    'the picture picker answers the file, null, or a file that is gone',
    {
      opens: [
        ['$DIR/pic.png'],
        ['$DIR/pic.JPG'],
        null,
        [],
        ['$DIR/missing.png'],
        ['$DIR/empty.png'],
      ],
    },
    [
      call('slides:pick-picture-file'),
      call('slides:pick-picture-file'),
      call('slides:pick-picture-file'),
      call('slides:pick-picture-file'),
      call('slides:pick-picture-file'),
      call('slides:pick-picture-file'),
    ],
  ),
  run(
    'an image is inserted from a file the dialog picked',
    {
      opens: [
        ['$DIR/pic.png'],
        ['$DIR/pic.JPG'],
        ['$DIR/pic.tif'],
        ['$DIR/empty.png'],
        null,
        ['$DIR/missing.png'],
      ],
    },
    [
      OPEN_A,
      call('slides:insert-image', [0, 1280]),
      call('slides:insert-image', [1, 900]),
      call('slides:insert-image', [0, 1280]),
      call('slides:insert-image', [0, 1280]),
      call('slides:insert-image', [0, 1280]),
      call('slides:insert-image', [0, 1280]),
      call('slides:insert-image', [9, 1280]),
      call('slides:undo'),
      call('slides:get-render-slides'),
    ],
  ),
  run('image bytes are added and a picture is replaced', {}, [
    OPEN_A,
    call('slides:add-image-bytes', [{ slideIndex: 0, base64: 'AAEC', ext: 'png', ...box }]),
    call('slides:add-image-bytes', [
      { slideIndex: 0, base64: 'AAEC', ext: 'jpg', ...box, afterIndex: 0 },
    ]),
    call('slides:add-image-bytes', [{ slideIndex: 9, base64: 'AAEC', ext: 'png', ...box }]),
    call('slides:add-image-bytes', [{ slideIndex: 0, base64: '', ext: 'png', ...box }]),
    call('slides:replace-picture-bytes', [
      { slideIndex: 0, sourceId: 'e1', base64: 'AAEC', ext: 'png' },
    ]),
    call('slides:replace-picture-bytes', [
      { slideIndex: 0, sourceId: 'nope', base64: 'AAEC', ext: 'png', keepSrcRect: true },
    ]),
    call('slides:replace-picture-bytes', [
      { slideIndex: 9, sourceId: 'e1', base64: 'AAEC', ext: 'png' },
    ]),
  ]),
  run('ink is added as a picture', {}, [
    OPEN_A,
    call('slides:add-ink', [{ slideIndex: 0, base64: 'AAEC', payload: '{"strokes":[]}', ...box }]),
    call('slides:add-ink', [{ slideIndex: 9, base64: 'AAEC', payload: '{}', ...box }]),
    call('slides:add-ink', [{ slideIndex: 0, base64: '', payload: '', ...box }]),
  ]),
  run(
    'a background is set, reused and refused',
    { opens: [['$DIR/pic.png'], null, ['$DIR/pic.png']] },
    [
      OPEN_A,
      call('slides:edit-background', [
        { slideIndex: 0, kind: 'solid', color: '#ff0000', fitWidthPx: 1280 },
      ]),
      call('slides:edit-background', [
        {
          slideIndex: -1,
          kind: 'gradient',
          from: '#000000',
          to: '#ffffff',
          angleDeg: 45,
          fitWidthPx: 1280,
        },
      ]),
      call('slides:edit-background', [{ slideIndex: 0, kind: 'reset', fitWidthPx: 1280 }]),
      call('slides:edit-background', [
        { slideIndex: 1, kind: 'graphics', hidden: true, fitWidthPx: 1280 },
      ]),
      call('slides:edit-background', [
        { slideIndex: 9, kind: 'solid', color: '#00ff00', fitWidthPx: 1280 },
      ]),
      call('slides:edit-background', [
        { slideIndex: 0, kind: 'image', mode: 'stretch', fitWidthPx: 1280 },
      ]),
      call('slides:edit-background', [
        { slideIndex: 0, kind: 'image', mode: 'stretch', fitWidthPx: 1280 },
      ]),
      call('slides:edit-background', [
        { slideIndex: -1, kind: 'image', mode: 'tile', fitWidthPx: 1280 },
      ]),
      call('slides:edit-background', [
        { slideIndex: 0, kind: 'image', pick: false, mode: 'stretch', fitWidthPx: 1280 },
      ]),
      call('slides:is-dirty'),
      call('slides:undo'),
    ],
  ),
  run(
    "a picture fill from a file or from the renderer's bytes",
    { opens: [['$DIR/pic.png'], null] },
    [
      OPEN_A,
      call('slides:edit-image-fill', [
        { slideIndex: 0, targets: [{ sourceId: 'e1' }], mode: 'stretch' },
      ]),
      call('slides:edit-image-fill', [
        { slideIndex: 0, targets: [{ sourceId: 'e1' }, { sourceId: 'e2' }], mode: 'tile' },
      ]),
      call('slides:edit-image-fill', [
        {
          slideIndex: 0,
          targets: [{ sourceId: 'e1' }],
          mode: 'stretch',
          source: { base64: 'AAEC', ext: 'png' },
        },
      ]),
      call('slides:edit-image-fill', [
        {
          slideIndex: 0,
          targets: [{ sourceId: 'nope' }],
          mode: 'stretch',
          source: { base64: 'AAEC', ext: 'png' },
        },
      ]),
      call('slides:edit-image-fill', [
        { slideIndex: 9, targets: [], mode: 'stretch', source: { base64: 'AAEC', ext: 'png' } },
      ]),
    ],
  ),
  run(
    'media is inserted from a file and from bytes',
    {
      opens: [
        ['$DIR/clip.mp4'],
        ['$DIR/song.mp3'],
        ['$DIR/clip.avi'],
        null,
        ['$DIR/model.glb'],
        ['$DIR/missing.mp4'],
      ],
    },
    [
      OPEN_A,
      call('slides:insert-media', [0, 'video', 1280]),
      call('slides:insert-media', [0, 'audio', 1280]),
      call('slides:insert-media', [0, 'video', 1280]),
      call('slides:insert-media', [0, 'audio', 1280]),
      call('slides:insert-media', [0, 'video', 1280]),
      call('slides:insert-media', [0, 'audio', 1280]),
      call('slides:insert-media', [9, 'video', 1280]),
      call('slides:add-media-bytes', [
        { slideIndex: 0, kind: 'video', base64: 'AAEC', ext: 'mp4', name: 'v', ...box },
      ]),
      call('slides:add-media-bytes', [
        { slideIndex: 0, kind: 'audio', path: '$DIR/song.mp3', ext: 'mp3', name: 'a', ...box },
      ]),
      call('slides:add-media-bytes', [
        { slideIndex: 0, kind: 'audio', path: '$DIR/missing.mp3', ext: 'mp3', name: 'a', ...box },
      ]),
      call('slides:add-media-bytes', [
        { slideIndex: 9, kind: 'video', base64: 'AAEC', ext: 'mp4', name: 'v', ...box },
      ]),
      call('slides:media-data', [0, 'e1']),
    ],
  ),
  run(
    'a 3D model is picked, added and turned',
    { opens: [['$DIR/model.glb'], null, ['$DIR/missing.glb']] },
    [
      OPEN_A,
      call('slides:pick-model3d'),
      call('slides:pick-model3d'),
      call('slides:pick-model3d'),
      call('slides:add-model3d', [
        { slideIndex: 0, bytes: glb(), name: 'model', aspect: 1.5, fitWidthPx: 1280 },
      ]),
      call('slides:add-model3d', [
        { slideIndex: 9, bytes: glb(), name: 'model', aspect: 1.5, fitWidthPx: 1280 },
      ]),
      call('slides:set-model3d-view', [
        { slideIndex: 0, sourceId: 'e1', rot: { ax: 1, ay: 2, az: 3 } },
      ]),
      call('slides:set-model3d-view', [
        { slideIndex: 0, sourceId: 'nope', rot: { ax: 1, ay: 2, az: 3 }, posterBase64: 'AAEC' },
      ]),
      call('slides:set-model3d-view', [
        { slideIndex: 9, sourceId: 'e1', rot: { ax: 0, ay: 0, az: 0 } },
      ]),
      call('slides:model3d-data', [0, 'e1']),
    ],
  ),
  run('narration is recorded and cleared', {}, [
    OPEN_A,
    call('slides:save-recording', [
      { slides: [{ slideIndex: 0, wavBase64: 'AAEC', durationMs: 1500, advanceMs: 2000 }] },
    ]),
    call('slides:save-recording', [
      { slides: [{ slideIndex: 9, wavBase64: 'AAEC', durationMs: 1, advanceMs: 1 }] },
    ]),
    call('slides:save-recording', [{ slides: [] }]),
    call('slides:clear-narration', [[0, 1]]),
    call('slides:clear-narration', [[]]),
    call('slides:clear-narration', [[9]]),
  ]),
  run("slides are moved and a section's slides removed", {}, [
    OPEN_A,
    call('slides:move-slides', [{ slideIndexes: [0], insertAt: 2 }]),
    call('slides:move-slides', [{ slideIndexes: [1], insertAt: 0 }]),
    call('slides:move-slides', [{ slideIndexes: [], insertAt: 0 }]),
    call('slides:move-slides', [{ slideIndexes: [9], insertAt: 0 }]),
    call('slides:remove-section-slides', [{ id: null }]),
    call('slides:remove-section-slides', [{ id: 'nope' }]),
    call('slides:remove-section-slides', [{ id: UNDEFINED }]),
    call('slides:get-render-slides'),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: (cx) => loadSlides(cx).then(() => {}),
  cases,
  single: {
    'slides:clear-narration': 'the fake deck has no narration: the answer is null',
    'slides:media-data': 'the fake deck has no media part: the answer is null',
    'slides:model3d-data': 'the fake deck has no model: the answer is null',
    'slides:remove-section-slides':
      'the fake deck has no sections: the lead slides are the whole deck, so the answer is null',
  },
}
