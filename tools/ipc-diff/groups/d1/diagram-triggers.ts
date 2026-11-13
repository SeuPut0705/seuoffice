/**
 * Group `d1/diagram-triggers`: what the shell asks of the diagram editor
 * (tabs, menus, the MCP server) and the events it sends the renderer for it:
 * `requestDiagramSave`, `requestDiagramClose`, `diagramSaveToPath`,
 * `diagramFileRenamed`, `sendDiagramMenuCommand`, `sendDiagramExportRequest`,
 * `diagramReadText`, `diagramReadPage`, `diagramApplyOps`,
 * `writeDiagramCopiesNow`, `discardDiagramRecovery`, `diagramTabIdentity`.
 * A call that waits for the renderer is deferred, then answered by the
 * renderer's own send, then taken with `answerOf`, so the round trip is
 * compared on its full path. Save targets are tokens `...01`, `...02`;
 * questions to the renderer have ids `00000000-0000-4000-8000-000000000001`, ...
 * (`diagram:bytes-request` is sent by no TypeScript of the diagram app: it is
 * not in the channel table.)
 */
import { diagramTriggers, loadDiagram } from '../../d1/diagram-host.ts'
import {
  CHANGED,
  DIAGRAM,
  TOKEN,
  answerOf,
  bin,
  call,
  diagramCase,
  opened,
  send,
  trigger,
} from '../../d1/diagram-cases.ts'
import type { Case, Group } from '../../types.ts'

const OPEN_A = call('diagram:open-file', ['$DIR/a.drawio'])
const dirty = send('diagram:dirty-changed', [true])
const FILE = { d1: opened('a.drawio') }
const Q1 = '00000000-0000-4000-8000-000000000001'
const Q2 = '00000000-0000-4000-8000-000000000002'

const cases: Case[] = [
  // ---- requestDiagramSave ----
  diagramCase('a clean diagram with a file is saved at once, nothing is asked', FILE, [
    OPEN_A,
    trigger('requestDiagramSave', ['save']),
    trigger('requestDiagramSave', ['saveAs'], { defer: true }),
    send('diagram:save-request-ack', [false]),
    answerOf(3),
  ]),
  diagramCase('a save the renderer reports as not done', FILE, [
    OPEN_A,
    dirty,
    trigger('requestDiagramSave', ['save'], { defer: true }),
    send('diagram:save-request-ack', [false]),
    answerOf(2),
    trigger('requestDiagramSave', ['save'], { defer: true }),
    send('diagram:save-request-ack', [true]),
    answerOf(5),
  ]),
  diagramCase(
    'a Save As ends with the save call of the renderer',
    { ...FILE, saves: ['$DIR/copy.drawio'] },
    [
      OPEN_A,
      dirty,
      trigger('requestDiagramSave', ['saveAs'], { defer: true }),
      call('diagram:save-target', [{ mode: 'saveAs' }]),
      call('diagram:save', [{ token: TOKEN, bytes: bin(CHANGED) }]),
      answerOf(2),
    ],
  ),
  diagramCase('a Save As the person cancels ends the wait', { ...FILE, saves: [null] }, [
    OPEN_A,
    trigger('requestDiagramSave', ['saveAs'], { defer: true }),
    call('diagram:save-target', [{ mode: 'saveAs' }]),
    answerOf(1),
  ]),
  diagramCase('a view whose file did not open is not saved', { d1: opened('bad.drawio') }, [
    call('diagram:open-file', ['$DIR/bad.drawio']),
    trigger('requestDiagramSave', ['save']),
  ]),

  // ---- requestDiagramClose ----
  diagramCase('a clean diagram closes without a question', FILE, [
    OPEN_A,
    trigger('requestDiagramClose', [true]),
  ]),
  diagramCase('Cancel keeps the tab; the renderer is not asked', { ...FILE, messages: [2] }, [
    OPEN_A,
    dirty,
    trigger('requestDiagramClose', [true]),
  ]),
  diagramCase('Save asks the renderer, and its result decides', { ...FILE, messages: [0, 0] }, [
    OPEN_A,
    dirty,
    trigger('requestDiagramClose', [true], { defer: true }),
    send('diagram:close-save-result', [true]),
    answerOf(2),
    trigger('requestDiagramClose', [false], { defer: true }),
    send('diagram:close-save-result', [false]),
    answerOf(5),
  ]),
  diagramCase("Don't Save closes at once", { ...FILE, messages: [1] }, [
    OPEN_A,
    dirty,
    trigger('requestDiagramClose', [true]),
  ]),

  // ---- diagramSaveToPath ----
  diagramCase('a tool saves to a new path through the renderer', FILE, [
    OPEN_A,
    dirty,
    trigger('diagramSaveToPath', ['$DIR/tool.drawio'], { defer: true }),
    call('diagram:save-target', [{ mode: 'retarget' }]),
    call('diagram:save', [{ token: TOKEN, bytes: bin(CHANGED) }]),
    answerOf(2),
    call('diagram:consume-pending'),
  ]),
  diagramCase('a tool save the renderer could not do puts the path back', FILE, [
    OPEN_A,
    trigger('diagramSaveToPath', ['$DIR/tool.drawio'], { defer: true }),
    send('diagram:save-request-ack', [false]),
    answerOf(1),
    call('diagram:save-target', [{ mode: 'save' }]),
  ]),
  diagramCase('a tool save to the file the diagram lives at, unchanged, writes nothing', FILE, [
    OPEN_A,
    trigger('diagramSaveToPath', ['$DIR/a.drawio']),
    dirty,
    trigger('diagramSaveToPath', ['$DIR/a.drawio'], { defer: true }),
    send('diagram:save-request-ack', [true]),
    answerOf(3),
  ]),
  diagramCase('a tool cannot save a view whose file did not open', { d1: opened('bad.drawio') }, [
    call('diagram:open-file', ['$DIR/bad.drawio']),
    trigger('diagramSaveToPath', ['$DIR/x.drawio']),
  ]),

  // ---- diagramFileRenamed, menu commands, export requests ----
  diagramCase(
    'a renamed file is granted again and the renderer is told',
    FILE,
    [
      OPEN_A,
      trigger('diagramFileRenamed', ['$DIR/a.drawio', '$DIR/z.drawio']),
      call('diagram:consume-pending'),
      call('diagram:save-target', [{ mode: 'save' }]),
      trigger('diagramTabIdentity'),
    ],
    {
      files: { 'a.drawio': DIAGRAM, 'z.drawio': DIAGRAM },
    },
  ),
  diagramCase("the menu's commands and exports reach the renderer", {}, [
    trigger('sendDiagramMenuCommand', ['undo']),
    trigger('sendDiagramMenuCommand', ['zoom-fit']),
    trigger('sendDiagramExportRequest', ['png']),
    trigger('sendDiagramExportRequest', ['pdf']),
  ]),
  diagramCase('a tab knows what it is', FILE, [
    trigger('diagramTabIdentity'),
    OPEN_A,
    trigger('diagramTabIdentity'),
  ]),
  diagramCase(
    'an imported diagram and an untitled one',
    { d1: { ...opened('v.vsdx'), recoveryTitle: 'Sketch' } },
    [
      trigger('diagramTabIdentity'),
      call('diagram:open-file', ['$DIR/v.vsdx']),
      trigger('diagramTabIdentity'),
    ],
  ),
  diagramCase('an untitled tab is named by the shell', { d1: { recoveryTitle: 'Sketch' } }, [
    trigger('diagramTabIdentity'),
  ]),

  // ---- the MCP server's questions ----
  diagramCase('the read table comes from the renderer that was asked', {}, [
    trigger('diagramReadText', [], { defer: true }),
    send('diagram:read-result', [{ id: Q2, text: 'wrong id' }]),
    send('diagram:read-result', [{ id: Q1, text: '| a | b |' }]),
    answerOf(0),
  ]),
  diagramCase('a renderer that cannot read says why', {}, [
    trigger('diagramReadText', [], { defer: true }),
    send('diagram:read-result', [{ id: Q1, error: 'no editor yet' }]),
    answerOf(0),
  ]),
  diagramCase('one page is read with its values', {}, [
    trigger('diagramReadPage', ['Page-2'], { defer: true }),
    send('diagram:read-result', [
      { id: Q1, text: 'p2', read: { pages: [{ id: 'a' }], page: { shapes: [], edges: [] } } },
    ]),
    answerOf(0),
    trigger('diagramReadPage', [], { defer: true }),
    send('diagram:read-result', [
      { id: '00000000-0000-4000-8000-000000000002', text: 'on screen', read: { pages: 1 } },
    ]),
    answerOf(3),
  ]),
  diagramCase('ops are applied only after a read was answered, once', {}, [
    trigger('diagramApplyOps', [[{ op: 'add' }]], { defer: true }),
    send('diagram:read-result', [{ id: Q1, text: '' }]),
    send('diagram:apply-result', [{ id: Q2, ok: true, result: { created: ['x'] } }]),
    answerOf(0),
  ]),
  diagramCase('a refused apply rejects', {}, [
    trigger('diagramApplyOps', [[]], { defer: true }),
    send('diagram:read-result', [{ id: Q1, text: '' }]),
    send('diagram:apply-result', [{ id: Q2, ok: false, error: 'plan refused' }]),
    answerOf(0),
  ]),
  diagramCase('applies to one view run one after another', {}, [
    trigger('diagramApplyOps', [['first']], { defer: true }),
    trigger('diagramApplyOps', [['second']], { defer: true }),
    send('diagram:read-result', [{ id: Q1, text: '' }]),
    send('diagram:apply-result', [{ id: Q2, ok: true, result: 1 }]),
    answerOf(0),
    send('diagram:read-result', [{ id: '00000000-0000-4000-8000-000000000003', text: '' }]),
    send('diagram:apply-result', [
      { id: '00000000-0000-4000-8000-000000000004', ok: true, result: 2 },
    ]),
    answerOf(1),
  ]),

  // ---- recovery copies on request ----
  diagramCase('at the end of the session each dirty diagram is asked for a copy', FILE, [
    OPEN_A,
    dirty,
    trigger('writeDiagramCopiesNow', [], { defer: true }),
    send('diagram:recovery-copy-now-done'),
    answerOf(2),
    trigger('writeDiagramCopiesNow'),
  ]),
  diagramCase('a clean diagram is not asked', FILE, [OPEN_A, trigger('writeDiagramCopiesNow')]),
  diagramCase("after Don't Save the tab that stays open is asked for a copy again", FILE, [
    OPEN_A,
    dirty,
    trigger('discardDiagramRecovery', [], { defer: true }),
    call('diagram:recovery-copy', [{ bytes: bin(DIAGRAM) }]),
    answerOf(2),
  ]),
]

export const group: Group = {
  batch: 'D1',
  load: loadDiagram,
  triggers: diagramTriggers,
  cases,
}
