/**
 * Group `d1/diagram`: the diagram editor's open, save, recovery, link,
 * seed, in-app question and headless channels (`apps/diagram/src/main/diagram-main.ts`,
 * `mcp-queries.ts`, `headless-main.ts`), loaded as the shell loads them
 * (`d1/diagram-host.ts`). Save targets are tokens counting up from
 * `00000000000000000000000000000001` on both sides.
 *
 * Not reachable by a call, so not covered here: the events the shell makes the
 * editor send (`save-request`, `close-save-request`, `file-renamed`,
 * `menu-command`, `export-request`, `recovery-copy-now`, `recovery-reset`,
 * `read-request`, `apply-request`, `bytes-request`); they come from
 * `requestDiagramSave` and its kin, which tabs, menus and the MCP server call.
 * A recovery copy that is written carries the clock in its metadata, and a
 * file that fails to write names its temporary file at random, so neither is
 * compared.
 */
import { diagramTriggers, loadDiagram } from '../../d1/diagram-host.ts'
import {
  CHANGED,
  DIAGRAM,
  FILES,
  TOKEN,
  TOKEN2,
  UNDEFINED,
  bin,
  call,
  diagramCase,
  opened,
  send,
  view,
} from '../../d1/diagram-cases.ts'
import type { Case, Group } from '../../types.ts'

const OPEN_A = call('diagram:open-file', ['$DIR/a.drawio'])
const target = (mode: string, defaultName?: unknown) =>
  call('diagram:save-target', [{ mode, defaultName: defaultName ?? UNDEFINED }])
const save = (token: string, bytes: unknown, auto?: boolean) =>
  call('diagram:save', [{ token, bytes, ...(auto === undefined ? {} : { auto }) }])
const dirty = (flag: unknown) => send('diagram:dirty-changed', [flag])

const cases: Case[] = [
  // ---- consume-pending, seed-take ----
  diagramCase('an untitled view has nothing queued', {}, [call('diagram:consume-pending')]),
  diagramCase('a view made for a file is told its path', diagramHost('a.drawio'), [
    call('diagram:consume-pending'),
  ]),
  diagramCase(
    'a path that is not there is not granted',
    { d1: { open: [{ view: 1, path: '$DIR/missing.drawio' }] } },
    [call('diagram:consume-pending'), call('diagram:open-file', ['$DIR/missing.drawio'])],
  ),
  diagramCase(
    'content queued for a new view is taken once',
    { d1: { open: [{ view: 1, seed: DIAGRAM }] } },
    [call('diagram:seed-take'), call('diagram:seed-take')],
  ),
  diagramCase(
    'a view that opens a file has no seed',
    { d1: { open: [{ view: 1, path: '$DIR/a.drawio', seed: DIAGRAM }] } },
    [call('diagram:seed-take')],
  ),

  // ---- open-file ----
  diagramCase('a granted diagram opens, and again', diagramHost('a.drawio'), [OPEN_A, OPEN_A]),
  diagramCase('a path not granted, and not a string', diagramHost('a.drawio'), [
    call('diagram:open-file', ['$DIR/b.drawio']),
    call('diagram:open-file', [3]),
    call('diagram:open-file'),
  ]),
  diagramCase(
    'a file that is not a diagram opens nothing and gets no target',
    diagramHost('bad.drawio'),
    [
      call('diagram:open-file', ['$DIR/bad.drawio']),
      target('save'),
      save(TOKEN, bin(DIAGRAM)),
      dirty(true),
      target('saveAs'),
    ],
  ),
  diagramCase('a name that is not a diagram is unsupported', diagramHost('c.txt'), [
    call('diagram:open-file', ['$DIR/c.txt']),
  ]),
  diagramCase('a folder named like a diagram is unreadable', diagramHost('dir.drawio'), [
    call('diagram:open-file', ['$DIR/dir.drawio']),
  ]),
  diagramCase(
    'a Visio drawing is read for the importer and stays untitled',
    diagramHost('v.vsdx'),
    [call('diagram:open-file', ['$DIR/v.vsdx']), call('diagram:consume-pending')],
  ),
  diagramCase(
    'the model decides what opens',
    {
      d1: {
        ...opened('a.drawio', 'b.drawio'),
        openDiagram: {
          'a.drawio': {
            ok: true,
            xml: '<mxfile compressed="true"/>',
            format: 'dio',
            root: 'mxfile',
          },
          'b.drawio': { ok: false, reason: 'corrupt_image', message: 'broken' },
        },
      },
    },
    [
      call('diagram:open-file', ['$DIR/a.drawio']),
      call('diagram:open-file', ['$DIR/b.drawio'], { view: 2 }),
    ],
    { views: [view(1), view(2)] },
  ),
  diagramCase(
    'a recovery question already answered opens the file as saved',
    { d1: { open: [{ view: 1, path: '$DIR/a.drawio', decision: 'original' }] } },
    [OPEN_A],
  ),

  // ---- save-target ----
  diagramCase(
    'an untitled diagram asks where, and offers .drawio in the default folder',
    { saves: ['$DIR/out'] },
    [target('save', 'My/Plan'), target('save')],
  ),
  diagramCase(
    'a picked name takes the format it ends in',
    { saves: ['$DIR/pic.drawio.png', '$DIR/plain.svg', null] },
    [target('saveAs', 'x'), target('saveAs'), target('saveAs')],
  ),
  diagramCase(
    'a view with a file saves to it; Save As asks, naming the file first',
    { ...diagramHost('a.drawio'), saves: ['$DIR/copy.dio'] },
    [OPEN_A, target('save'), target('retarget'), target('saveAs')],
  ),
  diagramCase(
    'the project folder is where an untitled diagram is offered',
    { d1: { newDocumentDir: '$DIR/proj' }, saves: [null] },
    [target('save', 'idea')],
  ),
  diagramCase(
    'an imported diagram is offered beside its file, under its name',
    { ...diagramHost('v.vsdx'), saves: ['$DIR/imported'] },
    [call('diagram:open-file', ['$DIR/v.vsdx']), target('save', 'ignored')],
  ),
  diagramCase('a request that is not an object', {}, [
    call('diagram:save-target'),
    call('diagram:save-target', ['saveAs']),
    call('diagram:save-target', [null]),
  ]),

  // ---- save ----
  diagramCase(
    'a target is used once: the diagram writes, the same token is spent',
    diagramHost('a.drawio'),
    [
      OPEN_A,
      target('save'),
      dirty(true),
      save(TOKEN, bin(CHANGED)),
      save(TOKEN, bin(CHANGED)),
      save('nope', bin(CHANGED)),
    ],
  ),
  diagramCase('what is not a diagram is refused, whatever the target', diagramHost('a.drawio'), [
    OPEN_A,
    target('save'),
    dirty(true),
    save(TOKEN, bin('<html/>')),
    target('save'),
    save(TOKEN2, 'not bytes'),
    save(TOKEN, UNDEFINED),
  ]),
  diagramCase('a clean diagram at its file writes nothing', diagramHost('a.drawio'), [
    OPEN_A,
    target('save'),
    save(TOKEN, bin(CHANGED)),
  ]),
  diagramCase(
    'an untitled diagram is saved where the person chose, and then has a file',
    { saves: ['$DIR/fresh'] },
    [
      target('saveAs', 'fresh'),
      save(TOKEN, bin(DIAGRAM)),
      target('save'),
      dirty(true),
      save(TOKEN2, bin(CHANGED)),
      call('diagram:consume-pending'),
    ],
  ),
  diagramCase(
    'a save to a file open in another pane goes ahead when the disk is unchanged',
    { d1: { open: [{ view: 1, path: '$DIR/a.drawio' }], openElsewhere: ['$DIR/a.drawio'] } },
    [
      OPEN_A,
      target('save'),
      dirty(true),
      save(TOKEN, bin(CHANGED), true),
      target('save'),
      save(TOKEN2, bin(DIAGRAM), false),
    ],
  ),
  diagramCase('a save is refused for a view whose file did not open', diagramHost('bad.drawio'), [
    call('diagram:open-file', ['$DIR/bad.drawio']),
    save(TOKEN, bin(DIAGRAM)),
  ]),

  // ---- save-into-project ----
  diagramCase('without project folders nothing is written', {}, [
    call('diagram:save-into-project', [{ bytes: bin(DIAGRAM), defaultName: 'p' }]),
  ]),
  diagramCase(
    'a new diagram goes into the project and then has its file',
    { d1: { writeNewDocument: { path: '$DIR/proj/p.drawio' } } },
    [
      call('diagram:save-into-project', [{ bytes: bin(DIAGRAM), defaultName: 'p/q' }]),
      call('diagram:save-into-project', [{ bytes: bin(DIAGRAM) }]),
      call('diagram:consume-pending'),
    ],
  ),
  diagramCase(
    'a bad request, a diagram that would not open, the project saying no',
    { d1: { writeNewDocument: { error: 'no room' } } },
    [
      call('diagram:save-into-project', [{ bytes: 'x' }]),
      call('diagram:save-into-project', [{ bytes: bin('<html/>') }]),
      call('diagram:save-into-project', [{ bytes: bin(DIAGRAM) }]),
    ],
  ),
  diagramCase('no project panel: skipped', { d1: { writeNewDocument: {} } }, [
    call('diagram:save-into-project', [{ bytes: bin(DIAGRAM) }]),
  ]),

  // ---- open-link, open-help ----
  diagramCase('only web and mail links are opened', {}, [
    call('diagram:open-link', ['https://a.example/x']),
    call('diagram:open-link', ['mailto:a@b.c']),
    call('diagram:open-link', ['javascript:alert(1)']),
    call('diagram:open-link', ['file:///etc/passwd']),
    call('diagram:open-link', [5]),
  ]),
  diagramCase(
    'a link the system could not open',
    { osShell: { openExternalError: 'no handler' } },
    [call('diagram:open-link', ['https://a.example/x'])],
  ),
  diagramCase('Help is handed to the shell', {}, [send('diagram:open-help')]),

  // ---- open-failed ----
  diagramCase(
    'only a view whose file did not open may close itself',
    { d1: { ...opened('bad.drawio'), openFailed: true } },
    [
      call('diagram:open-failed', ['  boom  ']),
      call('diagram:open-file', ['$DIR/bad.drawio']),
      call('diagram:open-failed', ['  boom  ']),
      call('diagram:open-failed', ['   ']),
      call('diagram:open-failed', [4]),
    ],
  ),
  diagramCase(
    'an import that did not become a file may close itself too',
    { d1: { ...opened('v.vsdx'), openFailed: false } },
    [call('diagram:open-file', ['$DIR/v.vsdx']), call('diagram:open-failed', ['x'.repeat(2100)])],
  ),

  // ---- dirty-changed, recovery-copy ----
  diagramCase(
    'a copy is not taken without unsaved changes, or from something that is not bytes',
    diagramHost('a.drawio'),
    [
      OPEN_A,
      call('diagram:recovery-copy', [{ bytes: bin(DIAGRAM) }]),
      dirty(true),
      call('diagram:recovery-copy', [{ bytes: 'no' }]),
      call('diagram:recovery-copy'),
      dirty('yes'),
      call('diagram:recovery-copy', [{ bytes: bin(DIAGRAM) }]),
    ],
  ),
  diagramCase(
    'a headless export keeps no copy',
    { d1: { ...opened('a.drawio'), headless: true } },
    [OPEN_A, dirty(true), call('diagram:recovery-copy', [{ bytes: bin(DIAGRAM), name: 'x' }])],
  ),
  diagramCase('a view whose file did not open takes no changes', diagramHost('bad.drawio'), [
    call('diagram:open-file', ['$DIR/bad.drawio']),
    dirty(true),
    call('diagram:recovery-copy', [{ bytes: bin(DIAGRAM) }]),
  ]),
  diagramCase(
    'a copy that cannot be written is an error for the renderer',
    diagramHost('a.drawio'),
    [OPEN_A, dirty(true), call('diagram:recovery-copy', [{ bytes: bin(DIAGRAM) }])],
    { files: { ...FILES, 'userData/diagram-autosave': 'in the way' } },
  ),

  // ---- provisional-title ----
  diagramCase(
    'an untitled diagram is named from its first request; one with a file keeps its name',
    diagramHost('a.drawio'),
    [
      send('diagram:provisional-title', ['  Sales   plan  ']),
      send('diagram:provisional-title', ['   ']),
      send('diagram:provisional-title', [4]),
      OPEN_A,
      send('diagram:provisional-title', ['Ignored']),
    ],
  ),
  diagramCase('an untitled view', {}, [send('diagram:provisional-title', ['x'.repeat(100)])]),

  // ---- answers of the renderer nobody is waiting for ----
  diagramCase('answers with no wait open change nothing', {}, [
    send('diagram:close-save-result', [true]),
    send('diagram:save-request-ack', [true]),
    send('diagram:recovery-copy-now-done'),
  ]),
  // The TypeScript registers read-result and apply-result when the MCP server first
  // asks (`listen()`), and nothing listens to bytes-result: Electron drops a send
  // nobody listens to, so the renderer sees no difference (divergences.json).
  diagramCase(
    'answers to questions nobody asked are dropped',
    {},
    [
      send('diagram:read-result', [{ id: 'x', text: 'y' }]),
      send('diagram:read-result', [null]),
      send('diagram:apply-result', [{ id: 'x', ok: true, result: 1 }]),
      send('diagram:bytes-result', [{ bytes: bin('x') }]),
    ],
    { files: {} },
  ),

  // ---- headless ----
  diagramCase(
    'a hidden window is given its job, and the job ends on the report',
    { d1: { open: [{ view: 1 }, { view: 2 }], headlessJob: { view: 2, path: '$DIR/a.drawio' } } },
    [
      call('diagram:headless-job', [], { view: 1 }),
      call('diagram:headless-job', [], { view: 2 }),
      send('diagram:headless-done', [{ ok: true }], 1),
      call('diagram:headless-job', [], { view: 2 }),
      send('diagram:headless-done', [{ ok: false, error: 'the page broke' }], 2),
      call('diagram:headless-job', [], { view: 2 }),
    ],
    { views: [view(1), view(2)] },
  ),
  diagramCase(
    'a report that is no report',
    { d1: { open: [{ view: 1 }], headlessJob: { view: 1, path: '$DIR/b.drawio' } } },
    [call('diagram:headless-job'), send('diagram:headless-done', ['junk'])],
  ),
]

/** a case's host with the view opened on `name` */
function diagramHost(name: string) {
  return { d1: opened(name) }
}

export const group: Group = {
  batch: 'D1',
  load: loadDiagram,
  triggers: diagramTriggers,
  cases,
  single: {
    'diagram:open-help': 'a send: the shell hook it calls is in the host log',
    'diagram:dirty-changed':
      'a send: its effect is read by the recovery-copy and save calls after it',
    'diagram:close-save-result': 'a send answers nothing; with no close waiting it changes nothing',
    'diagram:save-request-ack': 'a send answers nothing; with no save waiting it changes nothing',
    'diagram:recovery-copy-now-done':
      'a send answers nothing; with no copy waiting it changes nothing',
    'diagram:provisional-title': 'a send: its effect is the shell hook in the host log',
    'diagram:read-result':
      'a send: it settles a question the MCP server asked, which no call can start',
    'diagram:apply-result':
      'a send: it settles a question the MCP server asked, which no call can start',
    'diagram:bytes-result': 'a send nothing listens to',
    'diagram:headless-done': 'a send: its effect is read by headless-job after it',
  },
}
