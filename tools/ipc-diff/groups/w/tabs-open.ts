/**
 * Group `w/tabs-open`: what opens tabs. The nine `home:new-*` entries
 * (`registerHomeIpc`, `newDocTab`, `newSheetTab`, `newPdfTab` ... of
 * `apps/shell/src/main/index.ts`), files dropped from the OS
 * (`registerDroppedFilesIpc`, `routeDocumentPath`) and Home's call for the
 * agent window. See `w/tabs` for the world.
 */
import type { Case, FileSpec, Group } from '../../types.ts'
import { invoke, send, withViews } from './tabs.ts'
import { loadWorld, world } from './tabs-lib/world.ts'

const XLSX = '504b0304'
const PDF = '255044462d312e34'
const settings = { defaultSaveDir: '$DIR/documents/SeuOffice', blankXlsx: XLSX, blankPdf: PDF }
const home: Record<string, FileSpec> = { 'documents/SeuOffice': { dir: true } }
const newKinds = [
  'doc',
  'sheet',
  'slide',
  'markdown',
  'html',
  'mindmap',
  'diagram',
  'hwp',
  'pdf',
].map((kind) => invoke(`home:new-${kind}`))
const drop = (...paths: unknown[]) => send('app:open-dropped-files', paths)

const documents = {
  'documents/notes.md': '# notes\n',
  'documents/report.docx': 'PK',
  'documents/sheet.xlsx': 'PK',
  'documents/deck.pptx': 'PK',
  'documents/paper.pdf': '%PDF-1.4',
  'documents/page.html': '<p>x</p>',
  'documents/map.xmind': 'PK',
  'documents/draw.drawio':
    '<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>',
  'documents/bad.drawio': '<mxfile></mxfile>',
  'documents/book.epub': 'PK',
  'documents/han.hwp': 'x',
}

const cases: Case[] = [
  {
    note: 'every new-document entry opens its tab; the blank sheet and pdf are made',
    views: withViews(9),
    files: home,
    hosts: world(settings),
    calls: [...newKinds, invoke('tabs:list')],
  },
  {
    note: 'a folder of the home tree: the blank pdf lands in it, a folder outside the roots does not',
    views: withViews(4),
    files: {
      ...home,
      'documents/SeuOffice/proj': { dir: true },
      'documents/elsewhere': { dir: true },
    },
    hosts: world(settings),
    calls: [
      invoke('home:new-pdf', { dir: '$DIR/documents/SeuOffice/proj' }),
      invoke('home:new-pdf', { dir: '$DIR/documents/elsewhere' }),
      invoke('home:new-pdf', { dir: '$DIR/documents/SeuOffice' }),
      invoke('home:new-doc', { dir: '$DIR/documents/SeuOffice/proj' }),
      invoke('home:new-sheet', { dir: '$DIR/documents/SeuOffice/proj' }),
      invoke('tabs:list'),
    ],
  },
  {
    note: 'a second blank sheet is promised another name; a taken pdf name gets a number',
    views: withViews(3),
    files: { ...home, 'documents/SeuOffice/제목 없는 PDF.pdf': '%PDF' },
    hosts: world(settings),
    calls: [
      invoke('home:new-sheet'),
      invoke('home:new-sheet'),
      invoke('home:new-pdf'),
      invoke('tabs:list'),
    ],
  },
  {
    note: 'a view that cannot be made shows the error dialog',
    views: withViews(2),
    files: home,
    hosts: world({ ...settings, fail: ['createMarkdownView', 'createHwpView'] }),
    calls: [
      invoke('home:new-markdown'),
      invoke('home:new-hwp'),
      invoke('home:new-doc'),
      invoke('tabs:list'),
    ],
  },
  {
    note: 'dropped files open by their extension, each kind in its own tab',
    views: withViews(10),
    files: documents,
    hosts: world({
      refuse: [{ path: '$DIR/documents/bad.drawio', reason: '파일에 다이어그램 쪽이 없습니다.' }],
    }),
    calls: [
      drop(
        '$DIR/documents/notes.md',
        '$DIR/documents/report.docx',
        '$DIR/documents/sheet.xlsx',
        '$DIR/documents/deck.pptx',
        '$DIR/documents/paper.pdf',
      ),
      drop(
        '$DIR/documents/page.html',
        '$DIR/documents/map.xmind',
        '$DIR/documents/book.epub',
        '$DIR/documents/han.hwp',
        '$DIR/documents/draw.drawio',
      ),
      drop('$DIR/documents/bad.drawio'),
      drop('$DIR/documents/draw.drawio'),
      invoke('tabs:list'),
    ],
  },
  {
    note: 'a dropped file that is open already comes to the front; padding, duplicates, junk',
    views: withViews(3),
    files: documents,
    hosts: world(),
    calls: [
      drop('$DIR/documents/notes.md'),
      drop('  $DIR/documents/report.docx\t'),
      drop(
        '$DIR/documents/notes.md',
        '$DIR/documents/notes.md',
        7,
        null,
        '',
        '$DIR/documents/none.md',
      ),
      send('app:open-dropped-files', 'not a list'),
      send('app:open-dropped-files'),
      invoke('tabs:list'),
    ],
  },
  {
    note: 'formats the app knows it cannot open get one warning, beside the ones that open',
    views: withViews(2),
    files: documents,
    hosts: world(),
    calls: [
      drop(
        '$DIR/documents/notes.md',
        '$DIR/documents/a.rtf',
        '$DIR/documents/b.PAGES',
        '$DIR/documents/c.rtf',
      ),
      drop('$DIR/documents/d.key', '$DIR/documents/photo.png'),
    ],
  },
  {
    note: "another window of the shell may not open the agent window (Home's own call opens the agent module's window)",
    views: [
      { view: 1, window: 1, surface: 'Shell' },
      { view: 2, window: 2, surface: 'Shell' },
    ],
    hosts: world(),
    calls: [{ channel: 'home:open-agent-window', view: 2, args: [] }],
  },
]

export const group: Group = {
  batch: 'W',
  async load(cx) {
    await loadWorld(cx)
    // `home:open-agent-window` is answered by the agent module, which the entry
    // module configures once the app is ready
    const agent = await cx.fresh<{ configureAgentWindow(deps: never): void }>(
      'apps/shell/src/main/agent/agent-window.ts',
    )
    agent.configureAgentWindow({
      parentWindow: () => (cx.electron.BrowserWindow as { fromId(id: number): unknown }).fromId(1),
      lang: () => 'ko',
      theme: () => 'light',
      statuses: () => ({}),
      readPrefs: () => ({}),
      writePrefs: () => {},
      openPath: () => false,
    } as never)
  },
  cases,
  single: {
    'home:new-doc': 'answers nothing; the tab list and the log show what it did',
    'home:new-sheet': 'answers nothing; the tab list and the log show what it did',
    'home:new-slide': 'answers nothing; the tab list and the log show what it did',
    'home:new-markdown': 'answers nothing; the tab list and the log show what it did',
    'home:new-html': 'answers nothing; the tab list and the log show what it did',
    'home:new-mindmap': 'answers nothing; the tab list and the log show what it did',
    'home:new-diagram': 'answers nothing; the tab list and the log show what it did',
    'home:new-hwp': 'answers nothing; the tab list and the log show what it did',
    'home:new-pdf': 'answers nothing; the tab list and the log show what it did',
    'app:open-dropped-files': 'a send',
    'home:open-agent-window': "answers nothing; the window it opens is the agent module's",
  },
}
