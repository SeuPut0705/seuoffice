/**
 * Group `d1/mindmap`: the mind map editor's open, save, export, recovery,
 * attachment, link, hand-off, seed and in-app question channels
 * (`apps/mindmap/src/main/mindmap-main.ts`, `export-main.ts`,
 * `ai-attachments.ts`, `ai-image.ts`, `link-preview.ts`, `handoff-main.ts`,
 * `seed-main.ts`, `mcp-queries.ts`), loaded as the shell loads them
 * (`d1/mindmap-host.ts`).
 *
 * The events the shell makes the editor send (`save-request`,
 * `close-save-request`, `file-renamed`, `menu-command`, `export-request`,
 * `recovery-copy-now`, `outline-request`, `bytes-request`) come from
 * `requestMindmapSave` and its kin, which tabs, menus and the MCP server call:
 * a case makes those calls before its first call (`hosts.d1.mindmap.startup`),
 * on both sides, and the events arrive with the first call's. The one event
 * no case emits is `recovery-reset`: it is sent 5 s after "Don't Save" when
 * the tab is still open, from a timer, and a case ends sooner.
 *
 * A recovery copy that is written has a name that hashes the case's folder and
 * a clock in its metadata, so a case that writes one ends with a save that
 * deletes it. A write that fails says which temporary file it was writing, whose
 * name is random, so no case compares one. The reply channels of the in-app
 * questions (`outline-result`, `bytes-result`) are registered by the first
 * question on the TypeScript side and at once on the Rust side: a reply sent
 * before any question is dropped by Electron either way, which the fake
 * `ipcMain` shows as a missing handler, so no case sends one.
 */
import { loadMindmap } from '../../d1/mindmap-host.ts'
import {
  CHANGED,
  FILES,
  MAP,
  OPEN_A,
  PNG,
  SVG,
  UNDEFINED,
  bin,
  call,
  dirty,
  mindmapCase,
  opened,
  save,
  send,
  view,
} from '../../d1/mindmap-cases.ts'
import type { Case, Group } from '../../types.ts'

const FIXED_CLOCK = Date.UTC(2026, 10, 13, 9, 30, 15)

/** the host with a view opened on `name` */
const on = (name: string) => ({ d1: opened(name) })
const startup = (...steps: Record<string, unknown>[]) => ({ startup: steps })

const exportPng = (extra: Record<string, unknown> = {}) =>
  call('mindmap:export-png', [{ bytes: bin(PNG), suggestedName: 'map', ...extra }])
const exportSvg = (svg: unknown, extra: Record<string, unknown> = {}) =>
  call('mindmap:export-svg', [{ svg, suggestedName: 'map', ...extra }])

const cases: Case[] = [
  // ---- consume-pending, seed-take ----
  mindmapCase('an untitled view has nothing queued', {}, [call('mindmap:consume-pending')]),
  mindmapCase('a view made for a file is told its path', on('a.xmind'), [
    call('mindmap:consume-pending'),
  ]),
  mindmapCase('a path that is not there is not granted', { d1: { open: [{ view: 1, path: '$DIR/missing.xmind' }] } }, [
    call('mindmap:consume-pending'),
    call('mindmap:open-file', ['$DIR/missing.xmind']),
  ]),
  mindmapCase('content queued for a new view is taken once', { d1: { open: [{ view: 1, seed: { outline: '# a' } }] } }, [
    call('mindmap:seed-take'),
    call('mindmap:seed-take'),
  ]),
  mindmapCase('a copy of a map as the seed', { d1: { open: [{ view: 1, seed: { copy: MAP } }] } }, [
    call('mindmap:seed-take'),
  ]),
  mindmapCase('a view that opens a file has no seed', { d1: { open: [{ view: 1, path: '$DIR/a.xmind', seed: { outline: '# a' } }] } }, [
    call('mindmap:seed-take'),
  ]),

  // ---- open-file ----
  mindmapCase('a granted map opens, and again', on('a.xmind'), [OPEN_A, OPEN_A]),
  mindmapCase('a path not granted, and not a string', on('a.xmind'), [
    call('mindmap:open-file', ['$DIR/b.xmind']),
    call('mindmap:open-file', [3]),
    call('mindmap:open-file'),
  ]),
  mindmapCase('a file that is not a map opens nothing and gets no target', on('bad.xmind'), [
    call('mindmap:open-file', ['$DIR/bad.xmind']),
    save(bin(MAP), 'save'),
    dirty(true),
    save(bin(MAP), 'saveAs'),
    call('mindmap:recovery-copy', [{ bytes: bin(MAP) }]),
    call('mindmap:save-into-project', [{ bytes: bin(MAP) }]),
  ]),
  mindmapCase(
    'a map the engine does not take as ok, whatever the reason',
    { d1: opened('old.xmind', 'enc.xmind', 'empty.xmind', 'dir.xmind') },
    [
      call('mindmap:open-file', ['$DIR/old.xmind']),
      call('mindmap:open-file', ['$DIR/enc.xmind'], { view: 2 }),
      call('mindmap:open-file', ['$DIR/empty.xmind'], { view: 3 }),
      call('mindmap:open-file', ['$DIR/dir.xmind'], { view: 4 }),
    ],
    { views: [view(1), view(2), view(3), view(4)] },
  ),
  mindmapCase(
    'the engine decides what opens',
    { d1: { ...opened('a.xmind', 'b.xmind'), openXmind: [{ status: 'ok' }, { status: 'rejected', detail: 'broken' }] } },
    [call('mindmap:open-file', ['$DIR/a.xmind']), call('mindmap:open-file', ['$DIR/b.xmind'], { view: 2 })],
    { views: [view(1), view(2)] },
  ),
  mindmapCase(
    'a FreeMind map is read for the importer and stays untitled',
    { d1: opened('m.mm', 'Upper.MM', 'dir.mm') },
    [
      call('mindmap:open-file', ['$DIR/m.mm']),
      call('mindmap:consume-pending'),
      call('mindmap:open-file', ['$DIR/Upper.MM'], { view: 2 }),
      call('mindmap:open-file', ['$DIR/dir.mm'], { view: 3 }),
      save(bin(MAP), 'save', { defaultName: 'ignored' }),
      dirty(true, 3),
    ],
    { views: [view(1), view(2), view(3)] },
  ),
  mindmapCase('an imported map is offered an .xmind beside its .mm', { ...on('m.mm'), saves: ['$DIR/imported', null] }, [
    call('mindmap:open-file', ['$DIR/m.mm']),
    save(bin(MAP), 'save'),
    save(bin(MAP), 'saveAs'),
  ]),
  mindmapCase(
    'a recovery question already answered opens the file as saved',
    { d1: { open: [{ view: 1, path: '$DIR/a.xmind', decision: 'original' }] } },
    [OPEN_A],
  ),

  // ---- save ----
  mindmapCase('a map with a file saves to it', on('a.xmind'), [
    OPEN_A,
    dirty(true),
    save(bin(CHANGED), 'save'),
    save(bin(CHANGED)),
    call('mindmap:consume-pending'),
  ]),
  mindmapCase('what is not a map is refused, whatever the target', on('a.xmind'), [
    OPEN_A,
    dirty(true),
    save(bin('junk'), 'save'),
    save('not bytes', 'save'),
    save(UNDEFINED, 'save'),
    call('mindmap:save'),
    call('mindmap:save', ['text']),
    call('mindmap:save', [null]),
  ]),
  mindmapCase('the engine can refuse what a save brings', { d1: { ...opened('a.xmind'), openXmind: [{ status: 'ok' }, { status: 'encrypted' }] } }, [
    OPEN_A,
    save(bin(CHANGED), 'save'),
  ]),
  mindmapCase('Save As writes a copy and the map moves there; a cancel changes nothing', { ...on('a.xmind'), saves: ['$DIR/copy', null, '$DIR/other.XMIND'] }, [
    OPEN_A,
    save(bin(CHANGED), 'saveAs'),
    save(bin(CHANGED), 'saveAs'),
    save(bin(MAP), 'saveAs'),
    save(bin(CHANGED), 'save'),
    call('mindmap:consume-pending'),
  ]),
  mindmapCase('an untitled map asks where, offering a name in the default folder', { saves: [null, '$DIR/first'] }, [
    save(bin(MAP), 'save', { defaultName: 'My/Plan' }),
    save(bin(MAP), 'save', { defaultName: 'My/Plan' }),
    save(bin(CHANGED), 'save'),
    call('mindmap:consume-pending'),
  ]),
  mindmapCase('the project folder is where an untitled map is offered', { d1: { projectDir: '$DIR/proj' }, saves: [null] }, [
    save(bin(MAP), 'save', { defaultName: 'idea' }),
    save(bin(MAP), 'save'),
  ]),
  mindmapCase('Save As picks an export type: nothing is written, and the export takes exactly that path once', { saves: ['$DIR/pic.png', '$DIR/doc.pdf'] }, [
    save(bin(MAP), 'saveAs', { defaultName: 'x' }),
    exportPng({ path: '$DIR/other.png' }),
    exportPng({ path: '$DIR/pic.png' }),
    exportPng({ path: '$DIR/pic.png' }),
    save(bin(MAP), 'saveAs'),
    exportSvg(SVG, { path: '$DIR/doc.pdf' }),
    exportPng({ path: 5 }),
  ]),
  mindmapCase(
    'a save to a map open in two panes goes ahead, defers or asks by what the sibling wrote',
    {
      d1: { ...opened('a.xmind', 'a.xmind'), openElsewhere: ['$DIR/a.xmind'] },
      messages: [1, 0],
    },
    [
      call('mindmap:open-file', ['$DIR/a.xmind']),
      call('mindmap:open-file', ['$DIR/a.xmind'], { view: 2 }),
      call('mindmap:save', [{ bytes: bin(CHANGED), mode: 'save', auto: true }], { view: 2 }),
      call('mindmap:save', [{ bytes: bin(MAP), mode: 'save', auto: true }]),
      call('mindmap:save', [{ bytes: bin(MAP), mode: 'save' }]),
      call('mindmap:save', [{ bytes: bin(MAP), mode: 'save', auto: false }]),
    ],
    { views: [view(1), view(2)] },
  ),

  // ---- save-into-project ----
  mindmapCase('without project folders nothing is written', {}, [
    call('mindmap:save-into-project', [{ bytes: bin(MAP), defaultName: 'p' }]),
  ]),
  mindmapCase('a new map goes into the project and then has its file', { d1: { writeNewDocument: { path: '$DIR/proj/p.xmind' } } }, [
    call('mindmap:save-into-project', [{ bytes: bin(MAP), defaultName: 'p/q' }]),
    call('mindmap:save-into-project', [{ bytes: bin(MAP) }]),
    call('mindmap:consume-pending'),
  ]),
  mindmapCase('a bad request, a map that would not open, the project saying no', { d1: { writeNewDocument: { error: 'no room' } } }, [
    call('mindmap:save-into-project', [{ bytes: 'x' }]),
    call('mindmap:save-into-project', [{ bytes: bin('junk') }]),
    call('mindmap:save-into-project', [{ bytes: bin(MAP) }]),
    call('mindmap:save-into-project'),
  ]),
  mindmapCase('no project panel: skipped', { d1: { writeNewDocument: {} } }, [
    call('mindmap:save-into-project', [{ bytes: bin(MAP) }]),
  ]),

  // ---- open-link ----
  mindmapCase('only web and mail links are opened', {}, [
    call('mindmap:open-link', ['https://a.example/x']),
    call('mindmap:open-link', ['mailto:a@b.c']),
    call('mindmap:open-link', ['javascript:alert(1)']),
    call('mindmap:open-link', ['file:///etc/passwd']),
    call('mindmap:open-link', [5]),
  ]),
  mindmapCase('a link the system could not open', { osShell: { openExternalError: 'no handler' } }, [
    call('mindmap:open-link', ['https://a.example/x']),
  ]),

  // ---- dirty-changed, close-save-result, save-request-ack, recovery-copy ----
  mindmapCase('a copy is not taken without unsaved changes, or from something that is not bytes', on('a.xmind'), [
    OPEN_A,
    call('mindmap:recovery-copy', [{ bytes: bin(MAP) }]),
    dirty(true),
    call('mindmap:recovery-copy', [{ bytes: 'no' }]),
    call('mindmap:recovery-copy'),
    dirty('yes'),
    call('mindmap:recovery-copy', [{ bytes: bin(MAP) }]),
  ]),
  mindmapCase('a copy of an untitled map is written, listed under its name and dropped by the save', { d1: { recoveryTitle: 'Tab title' }, saves: ['$DIR/out'] }, [
    dirty(true),
    call('mindmap:recovery-copy', [{ bytes: bin(MAP), name: 'My   map' }]),
    save(bin(MAP), 'save'),
    call('mindmap:recovery-copy', [{ bytes: bin(MAP) }]),
  ]),
  mindmapCase('an untitled copy is named by what the renderer offers when the shell has no title', { saves: ['$DIR/out'] }, [
    dirty(true),
    call('mindmap:recovery-copy', [{ bytes: bin(MAP), name: '  Plan   B ' }]),
    call('mindmap:recovery-copy', [{ bytes: bin(MAP), name: 5 }]),
    save(bin(MAP), 'save'),
  ]),
  mindmapCase('the copy of a map with a file goes when the map is saved', on('a.xmind'), [
    OPEN_A,
    dirty(true),
    call('mindmap:recovery-copy', [{ bytes: bin(CHANGED) }]),
    call('mindmap:recovery-copy', [{ bytes: bin(CHANGED) }]),
    save(bin(CHANGED), 'save'),
  ]),
  mindmapCase('a copy that cannot be written is an error for the renderer', on('a.xmind'), [
    OPEN_A,
    dirty(true),
    call('mindmap:recovery-copy', [{ bytes: bin(CHANGED) }]),
  ], { files: { ...FILES, 'userData/mindmap-autosave': 'in the way' } }),
  mindmapCase(
    "after \"Don't Save\" no copy is taken while the tab closes",
    { d1: { open: [{ view: 1 }], ...startup({ call: 'dirty' }, { call: 'requestClose' }) }, messages: [1] },
    [call('mindmap:recovery-copy', [{ bytes: bin(MAP) }]), send('mindmap:recovery-copy-now-done')],
  ),
  mindmapCase('replies with no question open change nothing', {}, [
    send('mindmap:close-save-result', [true]),
    send('mindmap:save-request-ack', [true]),
    send('mindmap:recovery-copy-now-done'),
    send('mindmap:make-from-document'),
  ]),

  // ---- what the shell asks of the editor, and the renderer's answers ----
  mindmapCase('a menu save is answered by the save call', { d1: startup({ call: 'requestSave', mode: 'save' }), saves: ['$DIR/x'] }, [
    save(bin(MAP), 'save'),
    send('mindmap:save-request-ack', [true]),
  ]),
  mindmapCase('a menu save the renderer declined is answered by the ack', { d1: startup({ call: 'requestSave', mode: 'saveAs' }) }, [
    send('mindmap:save-request-ack', [false]),
    send('mindmap:save-request-ack', [true]),
  ]),
  mindmapCase(
    'the close prompt: Save asks the renderer, whose result answers',
    { d1: startup({ call: 'dirty' }, { call: 'requestClose' }), messages: [0] },
    [send('mindmap:close-save-result', [true]), send('mindmap:close-save-result', [false])],
  ),
  mindmapCase(
    'the close prompt: Cancel asks nothing more',
    { d1: startup({ call: 'dirty' }, { call: 'requestClose' }), messages: [2] },
    [send('mindmap:close-save-result', [true])],
  ),
  mindmapCase('a clean view closes without a question', { d1: startup({ call: 'requestClose' }) }, [
    call('mindmap:consume-pending'),
  ]),
  mindmapCase('the shell renames the file, and sends menu and export commands', {
    d1: {
      ...opened('a.xmind'),
      ...startup(
        { call: 'fileRenamed', from: '$DIR/a.xmind', to: '$DIR/c.xmind' },
        { call: 'menuCommand', command: 'zoom-in' },
        { call: 'exportRequest', format: 'png' },
      ),
    },
  }, [
    call('mindmap:consume-pending'),
    call('mindmap:open-file', ['$DIR/c.xmind']),
    call('mindmap:open-file', ['$DIR/a.xmind']),
  ], { files: { ...FILES, 'c.xmind': MAP } }),
  mindmapCase('the OS session ends: every unsaved map is asked for a copy now', {
    d1: startup({ call: 'dirty' }, { call: 'copiesNow' }),
  }, [send('mindmap:recovery-copy-now-done'), send('mindmap:recovery-copy-now-done')]),
  mindmapCase('the MCP server reads the outline and the bytes; the renderer answers', {
    d1: startup({ call: 'readOutline' }, { call: 'readBytes' }),
  }, [
    send('mindmap:outline-result', ['nope']),
    send('mindmap:outline-result', [null]),
    send('mindmap:outline-result', [{ other: 1 }]),
    send('mindmap:outline-result', [{ text: '# map' }]),
    send('mindmap:outline-result', [{ text: 'again' }]),
    send('mindmap:bytes-result', [{ bytes: bin('XMIND-live') }]),
  ]),
  mindmapCase('a failed read: an error reply, bytes that are not bytes', {
    d1: startup({ call: 'readOutline' }, { call: 'readBytes' }),
  }, [
    send('mindmap:outline-result', [{ error: 'boom' }]),
    send('mindmap:bytes-result', [{ bytes: 'text' }]),
  ]),
  mindmapCase('an error that is no string', {
    d1: startup({ call: 'readOutline' }, { call: 'readBytes' }),
  }, [
    send('mindmap:outline-result', [{ error: 5 }]),
    send('mindmap:bytes-result', [{ error: null }]),
  ]),

  // ---- hand-off, make-from-document, provisional-title ----
  mindmapCase(
    'a new tab takes its hand-off once; a run report must name it',
    { d1: { handoff: { id: 'h1', text: 'do it', materials: [{ path: '/a.md', name: 'a.md' }, { path: '/b.md', name: 'b.md' }] } } },
    [
      call('mindmap:handoff-take'),
      call('mindmap:handoff-take'),
      send('mindmap:handoff-run-started', ['junk']),
      send('mindmap:handoff-run-started', [{ id: 'other', attachedPaths: ['/a.md'] }]),
      send('mindmap:handoff-run-started', [{ id: 'h1', attachedPaths: [] }]),
      send('mindmap:handoff-run-started', [{ id: 'h1', attachedPaths: ['/a.md', '', 3, 'x'.repeat(5000), '/b.md'] }]),
      send('mindmap:handoff-run-started', [{ id: 'h1', attachedPaths: ['/a.md'] }]),
    ],
  ),
  mindmapCase('a view made for a file never takes the hand-off', { d1: { ...opened('a.xmind'), handoff: { id: 'h1', text: 't' } } }, [
    call('mindmap:handoff-take'),
  ]),
  mindmapCase('the toolbar asks the shell to make another document', {}, [send('mindmap:make-from-document')]),
  mindmapCase('an untitled map is named from its first request; one with a file keeps its name', on('a.xmind'), [
    send('mindmap:provisional-title', ['  Sales   plan  ']),
    send('mindmap:provisional-title', ['   ']),
    send('mindmap:provisional-title', [4]),
    send('mindmap:provisional-title', ['x'.repeat(100)]),
    OPEN_A,
    send('mindmap:provisional-title', ['Ignored']),
  ]),

  // ---- attachments ----
  mindmapCase('files are judged by extension and size', { d1: { attachable: { maxBytes: 8 } } }, [
    call('mindmap:files-add', [['$DIR/n.txt', '$DIR/x.zip', '$DIR/dir.xmind', '$DIR/missing.txt', 5, '', '$DIR/pic.png', '$DIR/notes.md']]),
    call('mindmap:files-add', ['not a list']),
    call('mindmap:files-add'),
  ]),
  mindmapCase('a picture over its limit is refused', { d1: { attachable: { imageMaxBytes: 4 } } }, [
    call('mindmap:files-add', [['$DIR/pic.png']]),
  ]),
  mindmapCase('the picker lists supported files; a cancel answers null', { opens: [['$DIR/n.txt', '$DIR/x.zip'], null, []] }, [
    call('mindmap:files-pick'),
    call('mindmap:files-pick'),
    call('mindmap:files-pick'),
  ]),
  mindmapCase('a text is read in pages and cached', {}, [
    call('mindmap:files-read', ['$DIR/n.txt', 2, 3]),
    call('mindmap:files-read', ['$DIR/n.txt', 8, 99]),
    call('mindmap:files-read', ['$DIR/n.txt', 'x', 0]),
    call('mindmap:files-read', ['$DIR/n.txt', -4, 1e9]),
    call('mindmap:files-read', ['$DIR/n.txt', null, 2.7]),
    call('mindmap:files-read', ['$DIR/n.txt', UNDEFINED, '4']),
  ]),
  mindmapCase('what cannot be read as text says why', {
    d1: {
      unsaved: ['$DIR/notes.md'],
      parseFileToText: {
        '$DIR/a.xmind': { ok: false, error: 'bad file', damaged: false },
        '$DIR/b.xmind': { ok: false, error: 'bad file', damaged: true },
        '$DIR/old.xmind': { ok: true, kind: 'pdf', text: 'x' },
        '$DIR/enc.xmind': { ok: true, kind: 'text' },
      },
      attachable: { maxBytes: 20 },
    },
  }, [
    call('mindmap:files-read'),
    call('mindmap:files-read', [5]),
    call('mindmap:files-read', ['']),
    call('mindmap:files-read', ['$DIR/x.zip', 0, 5]),
    call('mindmap:files-read', ['$DIR/pic.png', 0, 5]),
    call('mindmap:files-read', ['$DIR/notes.md', 0, 5]),
    call('mindmap:files-read', ['$DIR/missing.txt', 0, 5]),
    call('mindmap:files-read', ['$DIR/a.xmind', 0, 5]),
    call('mindmap:files-read', ['$DIR/b.xmind', 0, 5]),
    call('mindmap:files-read', ['$DIR/old.xmind', 0, 5]),
    call('mindmap:files-read', ['$DIR/enc.xmind', 0, 5]),
  ]),
  mindmapCase('a text over its limit is refused before it is parsed', { d1: { attachable: { maxBytes: 5 } } }, [
    call('mindmap:files-read', ['$DIR/n.txt', 0, 5]),
  ]),
  mindmapCase('a draw.io picture is judged by what it holds', { d1: { diagramPictureExt: { '$DIR/pic.png': 'drawio' }, attachable: { exts: ['txt', 'drawio', 'png'] } } }, [
    call('mindmap:files-add', [['$DIR/pic.png']]),
    call('mindmap:files-read', ['$DIR/pic.png', 0, 5]),
  ]),
  mindmapCase('a picture is read as base64 for the message', {}, [
    call('mindmap:files-read-image', ['$DIR/pic.png']),
    call('mindmap:files-read-image', ['$DIR/x.zip']),
    call('mindmap:files-read-image', ['$DIR/missing.png']),
    call('mindmap:files-read-image', [5]),
    call('mindmap:files-read-image'),
  ]),
  mindmapCase('a picture over its limit is not read', { d1: { attachable: { imageMaxBytes: 4 } } }, [
    call('mindmap:files-read-image', ['$DIR/pic.png']),
  ]),
  mindmapCase('a pasted picture is kept in the temp folder and then attached', { d1: { clock: FIXED_CLOCK } }, [
    call('mindmap:files-add-pasted-image', [bin('png-bytes'), 'PNG']),
    call('mindmap:files-add-pasted-image', [bin('jpg-bytes'), 'jpg']),
    call('mindmap:files-add-pasted-image', [bin('x'), 'exe']),
    call('mindmap:files-add-pasted-image', [bin(''), 'png']),
    call('mindmap:files-add-pasted-image', ['text', 'png']),
    call('mindmap:files-add-pasted-image', [bin('x')]),
  ]),
  mindmapCase('a pasted picture over the limit is refused before anything is written', { d1: { clock: FIXED_CLOCK, attachable: { imageMaxBytes: 4 } } }, [
    call('mindmap:files-add-pasted-image', [bin('12345'), 'png']),
  ]),
  mindmapCase('the temp folder cannot be made', { d1: { clock: FIXED_CLOCK } }, [
    call('mindmap:files-add-pasted-image', [bin('x'), 'png']),
  ], { files: { ...FILES, temp: 'in the way' } }),
  mindmapCase('old pasted pictures are removed once', { d1: { clock: FIXED_CLOCK } }, [
    call('mindmap:files-add-pasted-image', [bin('new'), 'png']),
    call('mindmap:files-add-pasted-image', [bin('new'), 'png']),
  ], {
    files: {
      ...FILES,
      'temp/seuoffice-pasted/old.png': { text: 'old', mtimeMs: FIXED_CLOCK - 8 * 24 * 3600 * 1000 },
      'temp/seuoffice-pasted/recent.png': { text: 'recent', mtimeMs: FIXED_CLOCK - 3600 * 1000 },
    },
  }),

  // ---- fetch-image, read-link-preview ----
  mindmapCase('a picture by address', { d1: { images: { 'https://a.example/i.png': { base64: 'QQ==', mime: 'image/png' } } } }, [
    call('mindmap:fetch-image', ['https://a.example/i.png']),
    call('mindmap:fetch-image', ['https://a.example/none.png']),
    call('mindmap:fetch-image', [5]),
    call('mindmap:fetch-image'),
  ]),
  mindmapCase('a link names its title and picture; a page that gives no picture has none', {
    d1: {
      pages: {
        'https://a.example/p': {
          contentType: 'text/html; charset=utf-8',
          url: 'https://a.example/p',
          body: '<html><head><title> Old &amp; title </title><meta property="og:title" content="Real &quot;title&quot;"><meta property="og:image" content="/img/i.png"></head></html>',
        },
        'https://a.example/q': {
          contentType: 'text/html',
          url: '',
          body: '<title>Only a title</title><link rel="image_src" href="//cdn.example/x.jpg">',
        },
        'https://a.example/r': { contentType: 'text/html', url: '', body: '<p>nothing</p>' },
        'https://a.example/moved': {
          contentType: 'text/HTML',
          url: 'https://b.example/dir/page',
          body: '<meta name="twitter:image" content="rel.png"><meta name="twitter:title" content="  Moved   page ">',
        },
      },
      images: {
        'https://a.example/img/i.png': { base64: 'QQ==', mime: 'image/png' },
        'https://b.example/dir/rel.png': { base64: 'Qg==', mime: 'image/gif' },
      },
    },
  }, [
    call('mindmap:read-link-preview', ['https://a.example/p']),
    call('mindmap:read-link-preview', ['  https://a.example/q  ']),
    call('mindmap:read-link-preview', ['https://a.example/r']),
    call('mindmap:read-link-preview', ['https://a.example/moved']),
  ]),
  mindmapCase('a link that is not a page, not a web address, not reachable', {
    d1: {
      pages: {
        'https://a.example/img': { contentType: 'image/png', body: 'x' },
        'https://a.example/down': { ok: false, contentType: 'text/html', body: 'x' },
        'https://a.example/boom': { throws: true },
        'https://a.example/latin': { contentType: 'text/html; charset=iso-8859-1', body: '<title>caf\u00e9</title>' },
        'https://a.example/meta': { contentType: 'text/html', body: '<meta charset="euc-kr"><title>x</title>' },
      },
    },
  }, [
    call('mindmap:read-link-preview', ['https://a.example/img']),
    call('mindmap:read-link-preview', ['https://a.example/down']),
    call('mindmap:read-link-preview', ['https://a.example/boom']),
    call('mindmap:read-link-preview', ['https://a.example/none']),
    call('mindmap:read-link-preview', ['ftp://a.example/x']),
    call('mindmap:read-link-preview', ['a.example']),
    call('mindmap:read-link-preview', [5]),
    call('mindmap:read-link-preview'),
    call('mindmap:read-link-preview', ['https://a.example/latin']),
    call('mindmap:read-link-preview', ['https://a.example/meta']),
  ]),

  // ---- exports ----
  mindmapCase('a picture export asks where, beside the map, and adds its extension', { ...on('a.xmind'), saves: ['$DIR/out', '$DIR/more.PNG', null] }, [
    OPEN_A,
    exportPng(),
    exportPng({ suggestedName: 'a/b:c' }),
    exportPng({ suggestedName: 5 }),
  ]),
  mindmapCase('an untitled map exports to the default folder', { saves: ['$DIR/untitled-out'] }, [
    exportPng({ suggestedName: '...' }),
    call('mindmap:export-png', [{ bytes: bin(PNG) }]),
  ]),
  mindmapCase('a picture that is not a picture, a request that is none', {}, [
    call('mindmap:export-png', [{ bytes: bin('nope'), suggestedName: 'm' }]),
    call('mindmap:export-png', [{ bytes: bin([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }]),
    call('mindmap:export-png', [{ bytes: 'text' }]),
    call('mindmap:export-png'),
    call('mindmap:export-png', [null]),
  ]),
  mindmapCase('an SVG export writes the declaration and the page', { saves: ['$DIR/map', '$DIR/map2.svg'] }, [
    exportSvg(SVG),
    exportSvg(SVG),
  ]),
  mindmapCase('an SVG that is not a map page is refused', {}, [
    exportSvg('<svg><script>x</script></svg>'),
    exportSvg('<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>x</SCRIPT></svg>'),
    exportSvg('<svg xmlns="http://www.w3.org/2000/svg"><g/>'),
    exportSvg(5),
    call('mindmap:export-svg'),
  ]),
  mindmapCase('an outline export', { saves: ['$DIR/outline', null] }, [
    call('mindmap:export-markdown', [{ text: '# map', suggestedName: 'o' }]),
    call('mindmap:export-markdown', [{ text: '# map', suggestedName: 'o' }]),
    call('mindmap:export-markdown', [{ text: 5 }]),
  ]),
  mindmapCase('a PDF export prints the page in a hidden window and writes it', { saves: ['$DIR/doc', null] }, [
    call('mindmap:export-pdf', [{ html: '<p>x</p>', suggestedName: 'd' }]),
    call('mindmap:export-pdf', [{ html: '<p>y</p>', suggestedName: 'd' }]),
    call('mindmap:export-pdf', [{ html: '' }]),
    call('mindmap:export-pdf', [{ html: 5 }]),
    call('mindmap:export-pdf'),
  ]),
  mindmapCase('a page that cannot be printed fails the export', { d1: { pdf: { error: 'no printer' } }, saves: ['$DIR/doc'] }, [
    call('mindmap:export-pdf', [{ html: '<p>x</p>', suggestedName: 'd' }]),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: loadMindmap,
  cases,
  single: {
    'mindmap:consume-pending': 'it takes no argument: its answer is the path the shell queued',
    'mindmap:seed-take': 'it takes no argument: its answer is what the shell queued',
    'mindmap:handoff-take': 'it takes no argument: its answer is what the shell queued',
    'mindmap:dirty-changed': 'a send: its effect is read by the recovery-copy and save calls after it',
    'mindmap:close-save-result': 'a send answers nothing; its effect is the close prompt it settles',
    'mindmap:save-request-ack': 'a send answers nothing; its effect is the menu save it settles',
    'mindmap:recovery-copy-now-done': 'a send answers nothing; its effect is the session end it settles',
    'mindmap:make-from-document': 'a send: its effect is the shell hook in the host log',
    'mindmap:provisional-title': 'a send: its effect is the shell hook in the host log',
    'mindmap:handoff-run-started': 'a send: its effect is the report in the host log',
    'mindmap:outline-result': 'a send: it settles a read the MCP server started',
    'mindmap:bytes-result': 'a send: it settles a read the MCP server started',
  },
}
