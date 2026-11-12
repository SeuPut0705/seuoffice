/**
 * Group `b2-print`: printer-options.ts, print-cups.ts, print-job.ts,
 * print-window.ts, print-html-pdf.ts, headless-mode.ts, handoff-editors.ts,
 * headless-export.ts and generate-handoff.ts of packages/electron-utils/src.
 *
 * Processes are a table from a command line (the file and its arguments
 * joined by a space) to what the process did; windows are driven by a script
 * of outcomes. Both sides log every call of a fake, one line per call. The
 * random part of a temp folder's name is written `<rand>` on both sides.
 *
 * The hand-off store is global state: a call of its functions takes the setup
 * steps as its first argument, runs them on a fresh store, then runs the
 * function itself with the other arguments, and answers `{ result, state }`.
 */
import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import type { execFile, spawn } from 'node:child_process'
import { parseFragment, serialize } from 'parse5'
import {
  HANDOFF_ATTACH_EDITORS,
  HANDOFF_EDITORS,
  handoffEditorTakesAttachments,
  isHandoffEditor,
  type HandoffEditor,
} from '../../../packages/electron-utils/src/handoff-editors.ts'
import {
  isHeadlessMode,
  setHeadlessMode,
} from '../../../packages/electron-utils/src/headless-mode.ts'
import {
  DRIVER_OPTION_NAMES,
  isValidOptionName,
  isValidOptionValue,
  parseLpOptions,
  queryPrinterOptions,
} from '../../../packages/electron-utils/src/printer-options.ts'
import {
  lpArgumentsFor,
  printPdfViaCups,
  printToPdfOptionsFor,
  type CupsPrintJob,
  type PrintToPdfRequest,
} from '../../../packages/electron-utils/src/print-cups.ts'
import { printJobOptions, printOutcome } from '../../../packages/electron-utils/src/print-job.ts'
import {
  PRINT_READY_SCRIPT,
  loadPrintHtml,
  printHtmlDocument,
  type PrintDialogWindow,
} from '../../../packages/electron-utils/src/print-window.ts'
import {
  buildPrintableHtml,
  printHtmlToPdf,
  sanitizePrintableBody,
  type PrintableHtml,
  type PrintWindow,
} from '../../../packages/electron-utils/src/print-html-pdf.ts'
import {
  DIAGRAM_BATCH_MODES,
  DIAGRAM_FILE_TARGETS,
  HEADLESS_EXIT,
  HEADLESS_EXPORT_FLAG,
  HEADLESS_SUPPORTED_EXTENSIONS,
  HEADLESS_TARGETS,
  documentFontsSettled,
  formatHeadlessEnvelope,
  headlessExitCode,
  headlessModuleFor,
  headlessSleep,
  headlessSummary,
  isDiagramFileTarget,
  parseHeadlessExportArgv,
  pollUntilReady,
  runHeadlessRendererExport,
  type HeadlessExportFormat,
  type HeadlessExportOutcome,
} from '../../../packages/electron-utils/src/headless-export.ts'
import * as handoff from '../../../packages/electron-utils/src/generate-handoff.ts'
import type {
  GenerateHandoff,
  SkillHandoff,
} from '../../../packages/electron-utils/src/generate-handoff.ts'
import type { Case, Group, TsContext } from '../types.ts'

const str = (a: unknown[], i: number): string => a[i] as string
/** a `null` argument is an argument left out */
const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : value

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

/** a constant has one answer */
const CONSTANT = 'a constant'

// ---------- fake processes ----------

interface Entry {
  code?: number | null
  stdout?: string
  stderr?: string
  error?: string
}
type Table = Record<string, Entry>

const commandLine = (file: string, args: readonly string[]): string => [file, ...args].join(' ')

/** `spawn` whose process ends as the table says, after `stdin.end` */
function fakeSpawn(table: Table, log: TsContext['log']): typeof spawn {
  return ((file: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = Object.assign(new EventEmitter(), {
      end(chunk: Buffer) {
        log('run', file, [...args], Buffer.from(chunk).toString('hex'))
        const line = commandLine(file, args)
        const entry = Object.hasOwn(table, line) ? table[line] : undefined
        setImmediate(() => {
          if (entry === undefined) {
            child.emit('error', new Error(`no such command: ${line}`))
          } else if (entry.error !== undefined) {
            child.emit('error', new Error(entry.error))
          } else {
            if (entry.stdout) (child.stdout as EventEmitter).emit('data', Buffer.from(entry.stdout))
            if (entry.stderr) (child.stderr as EventEmitter).emit('data', Buffer.from(entry.stderr))
            child.emit('close', entry.code === undefined ? 0 : entry.code)
          }
        })
      },
    })
    return child
  }) as unknown as typeof spawn
}

/** `execFile` whose process ends as the table says */
function fakeExecFile(table: Table, log: TsContext['log']): typeof execFile {
  return ((
    file: string,
    args: string[],
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    log('run', file, [...args], null)
    const line = commandLine(file, args)
    const entry = Object.hasOwn(table, line) ? table[line] : undefined
    setImmediate(() => {
      if (entry === undefined) callback(new Error(`no such command: ${line}`), '')
      else if (entry.error !== undefined) callback(new Error(entry.error), '')
      else if ((entry.code === undefined ? 0 : entry.code) !== 0)
        callback(new Error('exit'), entry.stdout ?? '')
      else callback(null, entry.stdout ?? '')
    })
  }) as unknown as typeof execFile
}

// ---------- fake windows ----------

interface Script {
  loadFile?: 'throws'
  exec?: 'rejected' | 'throws' | 'pending'
  print?: 'throws' | { success?: boolean; reason?: string }
  showThrows?: boolean
  focusThrows?: boolean
  destroyed?: boolean
  isDestroyedThrows?: boolean
  destroyThrows?: boolean
  createWindow?: 'throws'
  printToPDF?: 'throws'
  pdfHex?: string
}

/** logs `loadFile` with the folder's random part cut off, and the file's text */
function logLoad(path: string, log: TsContext['log']): void {
  const at = path.lastIndexOf('/')
  const dir = path.slice(0, at)
  const dirBase = dir.slice(dir.lastIndexOf('/') + 1)
  log('loadFile', dirBase.slice(0, -6), path.slice(at + 1), readFileSync(path, 'utf8'))
}

function dialogWindow(script: Script, log: TsContext['log']): PrintDialogWindow {
  let destroyed = script.destroyed === true
  const report = typeof script.print === 'object' ? script.print : {}
  return {
    async loadFile(path: string) {
      logLoad(path, log)
      if (script.loadFile === 'throws') throw new Error('load failed')
    },
    webContents: {
      executeJavaScript(js: string, gesture?: boolean) {
        log('executeJavaScript', js, gesture)
        if (script.exec === 'throws') throw new Error('probe threw')
        if (script.exec === 'rejected') return Promise.reject(new Error('probe rejected'))
        if (script.exec === 'pending') return new Promise<unknown>(() => undefined)
        return Promise.resolve(undefined)
      },
      print(options, callback) {
        log('print', options)
        if (script.print === 'throws') throw new Error('print threw')
        callback(report.success === true, report.reason ?? '')
      },
    },
    show() {
      log('show')
      if (script.showThrows) throw new Error('show threw')
    },
    focus() {
      log('focus')
      if (script.focusThrows) throw new Error('focus threw')
    },
    isDestroyed() {
      log('isDestroyed')
      if (script.isDestroyedThrows) throw new Error('isDestroyed threw')
      return destroyed
    },
    destroy() {
      log('destroy')
      destroyed = true
      if (script.destroyThrows) throw new Error('destroy threw')
    },
  }
}

const maskRand = (text: string): string =>
  text.replace(/\/(seuoffice-print-|seuoffice-ai-doc-|zz-)[A-Za-z0-9]{6}/g, '/$1<rand>')

/** the call with the random part of a temp folder masked in what it returns or throws */
async function masked<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await run()
    return value === undefined ? undefined : (JSON.parse(maskRand(JSON.stringify(value))) as T)
  } catch (error) {
    if (error instanceof Error) error.message = maskRand(error.message)
    throw error
  }
}

/**
 * `console.error` of the readiness probe goes to the log, and the probe's 5 s
 * timer fires on the next turn instead of after 5 s.
 */
async function withProbe<T>(cx: TsContext, run: () => Promise<T>): Promise<T> {
  const realError = console.error
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  console.error = (message: unknown, error: unknown) =>
    cx.log('console.error', message, error instanceof Error ? error.message : String(error))
  globalThis.setTimeout = ((fn: () => void) => {
    const timer = { cleared: false }
    setImmediate(() => {
      if (!timer.cleared) fn()
    })
    return timer
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((timer?: { cleared: boolean }) => {
    if (timer) timer.cleared = true
  }) as unknown as typeof clearTimeout
  try {
    return await run()
  } finally {
    console.error = realError
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// ---------- cases: printer-options, print-cups ----------

const LPOPTIONS = [
  'PageSize/Media Size: *Letter A4 Legal',
  'cupsPrintQuality/Quality: Draft *Normal High',
  'ColorModel/Color Mode: *Gray RGB CMYK',
  'MediaType/Media Type: *Plain Glossy',
  'Duplex/Double-Sided Printing: None *DuplexNoTumble DuplexTumble',
  '',
].join('\n')

const A64 = 'a'.repeat(64)
const LP_QUERY = '/usr/bin/lpoptions -p Office -l'

const lpCases: Case[] = [
  LPOPTIONS,
  '',
  'no colon here\nName/Tr: a b\n   Indented/Tr:   x   *y   z   \n',
  'A/B: *x *y z',
  'A/B: x x x *x',
  'A/B: *',
  'A/B: * x',
  'A/B: bad$value ok bad/value',
  'A/B:',
  'A/B: ',
  'A/B:x',
  `${A64}/T: v`,
  `${A64}a/T: v`,
  `N/T: ${A64} ${A64}a`,
  `N/${'t'.repeat(128)}: v`,
  `N/${'t'.repeat(129)}: v`,
  `N/${'\u{1F600}'.repeat(64)}: v`,
  `N/${'\u{1F600}'.repeat(65)}: v`,
  'N/Tr:ans: a',
  'N/a b c: v1 v2\r\nM/x y: z\r\n',
  'N/T\r: a',
  'N/T: a\rb',
  'N/T: a\u2028b',
  'N/T: a\u0085b',
  '\u00a0N/T: a\u00a0b *c\u00a0',
  '\uFEFFN/T: a',
  'N/\u00e9\u0131\u017F\u212A: k',
  'N\u0131/T: a',
  'Name.With+Chars-1_2/T: a.b +c -d _e *.f',
  'N/T: a\n\n\nM/T: b',
  'N/T: *a\u0131 b',
  '/T: a',
  'N/: a',
].map((raw): Case => ({ args: [raw] }))

const OPTION_TEXTS = [
  'a',
  'A_b.c+d-e',
  '',
  '-',
  'ab cd',
  'ab\n',
  '\nab',
  A64,
  `${A64}a`,
  'caf\u00e9',
  'a\u0131',
  'k\u212A',
  's\u017F',
  '\u{1F600}',
  'a/b',
  'a=b',
]

const CUPS_FAIL = '/usr/bin/lp'

const cupsRun = (pdf: string, job: CupsPrintJob, table: Table, note: string): Case => ({
  args: [pdf, job, table],
  note,
})

// ---------- cases: print-job ----------

const DRIVER = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `Opt${i}`, value: `v${i}` }))

const jobCases: unknown[][] = [
  [],
  [null],
  ['x'],
  [5],
  [true],
  [[]],
  [[{ deviceName: 'HP' }]],
  [{}],
  [{ deviceName: null }],
  [{ deviceName: 5, copies: 3 }],
  [{ deviceName: '' }],
  [{ deviceName: 'HP LaserJet' }],
  [{ deviceName: 'HP', copies: 1 }],
  [{ deviceName: 'HP', copies: 999 }],
  [{ deviceName: 'HP', copies: 1000 }],
  [{ deviceName: 'HP', copies: 0 }],
  [{ deviceName: 'HP', copies: -3 }],
  [{ deviceName: 'HP', copies: 2.5 }],
  [{ deviceName: 'HP', copies: '2' }],
  [{ deviceName: 'HP', copies: 1e21 }],
  [{ deviceName: 'HP', collate: true }],
  [{ deviceName: 'HP', collate: false }],
  [{ deviceName: 'HP', collate: 'true' }],
  [{ deviceName: 'HP', duplex: 'simplex' }],
  [{ deviceName: 'HP', duplex: 'longEdge' }],
  [{ deviceName: 'HP', duplex: 'shortEdge' }],
  [{ deviceName: 'HP', duplex: 'longedge' }],
  [{ deviceName: 'HP', duplex: 'constructor' }],
  [{ deviceName: 'HP', duplex: 7 }],
  [{ pageSizeIn: { width: 8.27, height: 11.69 } }],
  [{ deviceName: 'HP', pageSizeIn: { width: 8.5, height: 11 } }],
  [{ pageSizeIn: { width: 0, height: 11 } }],
  [{ pageSizeIn: { width: 8, height: 0 } }],
  [{ pageSizeIn: { width: -1, height: 11 } }],
  [{ pageSizeIn: { width: 200, height: 200 } }],
  [{ pageSizeIn: { width: 200.0001, height: 11 } }],
  [{ pageSizeIn: { width: 8, height: 200.5 } }],
  [{ pageSizeIn: { width: '8', height: 11 } }],
  [{ pageSizeIn: { width: 8 } }],
  [{ pageSizeIn: null }],
  [{ pageSizeIn: [8, 11] }],
  [{ pageSizeIn: 'A4' }],
  [{ pageSizeIn: { width: 0.00001968503937007874, height: 0.00003937007874015748 } }],
  [{ pageSizeIn: { width: 1.5e-5, height: 1e-5 } }],
  [{ pageSizeIn: { width: 3.3, height: 4.4 }, deviceName: '' }],
  [{ deviceName: 'HP', driverOptions: [{ name: 'ColorModel', value: 'Gray' }] }],
  [{ deviceName: 'HP', driverOptions: [] }],
  [{ deviceName: 'HP', driverOptions: 'x' }],
  [{ deviceName: 'HP', driverOptions: DRIVER(20) }],
  [{ deviceName: 'HP', driverOptions: DRIVER(16) }],
  [
    {
      deviceName: 'HP',
      driverOptions: [
        { name: 'bad name', value: 'x' },
        { name: 'ok', value: 'bad value' },
        { name: 'ok2', value: 5 },
        { name: 5, value: 'x' },
        null,
        'str',
        [1],
        { name: 'ok3' },
        { value: 'v' },
        { name: 'x\n', value: 'y' },
        { name: 'good', value: 'y', extra: 1, '2': 'two', '10': 'ten' },
      ],
    },
  ],
  [{ deviceName: 'HP', driverOptions: [{ name: 'bad', value: 'x y' }] }],
  [
    {
      deviceName: 'HP',
      driverOptions: [
        ...Array.from({ length: 16 }, () => ({ name: '!', value: 'v' })),
        { name: 'late', value: 'ok' },
      ],
    },
  ],
  [{ deviceName: '', copies: 3, collate: true, duplex: 'simplex', driverOptions: DRIVER(1) }],
  [
    {
      deviceName: 'Printer \u00e9\u{1F600}',
      copies: 7,
      collate: false,
      duplex: 'shortEdge',
      pageSizeIn: { width: 11, height: 17 },
      driverOptions: DRIVER(2),
    },
  ],
]

// ---------- cases: print-html-pdf ----------

const FRAGMENTS = [
  '',
  'plain text',
  'plain & <text> > done',
  '<p>Hello</p>',
  '<P>Upper</P>',
  '<h1>t</h1><h2>u</h2><h3>v</h3><h4>w</h4><h5>x</h5><h6>y</h6><h7>z</h7>',
  '<p class="a" style="x" onclick="alert(1)" id=b>attrs</p>',
  '<a href="javascript:alert(1)" title=\'q"q\'>link</a>',
  '<ul><li>one<li>two<ul><li>nested</ul></ul>',
  '<ol start=3><li>a</li></ol>',
  '<table><tr><td>cell</td></tr></table>',
  '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>',
  '<td>orphan cell</td>',
  '<tr><td>orphan row</td></tr>',
  '<tbody><tr><td>x</td></tr></tbody>',
  '<col><colgroup><col></colgroup>',
  '<caption>cap</caption>',
  '<table>text<tr><td>x</td></tr>more</table>',
  '<table><tr><td>x<b>y</table>z',
  '<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>',
  '<table><td>a<td>b<tr><td>c</table>',
  '<br>',
  '<br/>',
  '</br>',
  '<br></br>',
  'a<br>b<br/>c',
  '<hr><img src=x><input value=y><wbr>',
  '<image src=x>text',
  '<p/>x',
  '<a/>x',
  '</p>',
  '</p></div></span>',
  '<p>one<p>two',
  '<p>a<div>b</p>c',
  '<p><b>bold<p>next</b>text',
  '<b><i>x</b>y</i>z',
  '<i><p>x</i>y</p>',
  '<a>1<a>2</a>3</a>',
  '<a href=x><table><a>',
  '<b><b><b><b><b>deep</b></b></b></b></b>',
  '<p><b>x</p><p>y</b>z',
  '<h1>a<h2>b</h2></h1>',
  '<li>x<li>y',
  '<dd>d<dt>t<dd>e',
  '<strong>a</strong><em>b</em><u>c</u><s>d</s><code>e</code>',
  '<pre>\nfirst\n\nthird</pre>',
  '<pre>\n\nx</pre>',
  '<pre><code>x &lt; y &amp;&amp; z</code></pre>',
  '<blockquote><p>q</blockquote>after',
  '<formula>E=mc^2</formula><FORMULA>X</FORMULA>',
  '<script>alert(1)</script>after',
  '<script>alert(1)',
  '<SCRIPT>x</SCRIPT>',
  '<script src=x></script><p>ok</p>',
  '<style>p{color:red}</style>text',
  '<style>',
  '<iframe src=x>fallback</iframe>y',
  '<frameset><frame src=x></frameset>',
  '<object><param name=a>fallback</object>',
  '<embed src=x>',
  '<link rel=stylesheet href=x><meta charset=x><base href=x>t',
  '<form action=x><input name=a><button>b</button></form>',
  '<template><b>hidden</b></template>shown',
  '<template><td>x</td></template>',
  '<noscript><p>x</p></noscript>y',
  '<svg><a>x</a></svg>after',
  '<svg><foreignObject><p>x</p></foreignObject></svg>',
  '<svg><style>p{}</style><title>t</title></svg>',
  '<math><mi>x</mi></math>after',
  '<math><annotation-xml encoding="text/html"><p>x</p></annotation-xml></math>',
  '<!-- comment -->text',
  '<!--a--b-->c',
  '<!---->d',
  '<!-->e',
  '<!--->f',
  '<!-- unterminated',
  '<? pi ?>g',
  '<![CDATA[ x ]]>h',
  '<!DOCTYPE html><p>d</p>',
  '<!ELEMENT x>i',
  '<!>j',
  '</>k',
  '<>l',
  '< p>m',
  '<p',
  '<p class="x',
  '<p class=x',
  '&amp;&lt;&gt;&quot;&apos;',
  '&amp;lt;',
  '&nbsp;&nbsp;x',
  '&copy &copy; &copy=1',
  '&notit; &notin; &not',
  '&amp &AMP &Amp;',
  '&#65;&#x41;&#X41;',
  '&#0; &#x0; &#128; &#x80; &#x9F; &#xD800; &#xDFFF; &#x110000; &#1114112;',
  '&#x1F600; &#128512;',
  '&#; &#x; &#xg; &#12',
  '&unknown; &x',
  'a\u0000b',
  '<p>a\u0000b</p>',
  '<pre>\u0000</pre>',
  'a\r\nb\rc\n\rd',
  '\uFEFF<p>bom</p>',
  'x\uFEFFy',
  '<p>\u00e9\u{1F600}\u0131\u017F\u212A</p>',
  '<p>a\u00a0b\u2028c\u2029d</p>',
  '<bloc\u212Aquote>kelvin</bloc\u212Aquote>',
  '<lin\u212A rel=x>dropped</lin\u212A>after',
  '<scr\u0130pt>x</scr\u0130pt>',
  '<\u0130p>x',
  '<a\u0131>x</a\u0131>',
  '<\u00e9>x</\u00e9>',
  '<p\u{1F600}>x</p\u{1F600}>',
  '<custom-tag>c</custom-tag>',
  '<my:tag>x</my:tag>',
  '<head><title>t</title></head><body><p>b</p></body>',
  '<html><body>x</body></html>',
  '<body class=a>b',
  '<title>t</title>',
  '<textarea><b>x</b></textarea>y',
  '<xmp><b>x</b></xmp>y',
  '<plaintext><b>x',
  '<listing>\nx</listing>',
  '<select><option>a<option>b</select>',
  '<option>x',
  '<button>b<button>c</button></button>',
  '<label>l</label><span>s</span><div>d</div>',
  '<center>c</center><font size=1>f</font><nobr>n</nobr>',
  '<marquee>m</marquee><ruby>r<rt>t</ruby>',
  '<isindex>',
  '<keygen>',
  '<nextid>',
  '<![if x]>y<![endif]>',
  '<div><div><div><div><div><div><div><div><div><div>deep</div></div></div></div></div></div></div></div></div></div>',
  '<p>' + 'x'.repeat(2000) + '</p>',
  '<p>' + '<b>'.repeat(40) + 'x',
  '<ul>' + '<li>'.repeat(60) + 'x',
  'before<table><caption>c<td>x</table>after',
  '<tr><td>a</td><td>b</td></tr><tr><td>c</td></tr>',
  '<th>h</th><td>d</td>',
  '<frame>',
  '<frameset>',
  '<a href=x>1</a><a href=y>2</a>',
  '<p>one</p>\n<p>two</p>\n',
  '  <p>sp</p>  ',
]

const TITLES = [
  'Report',
  '',
  'A & B',
  '<script>alert("x")</script>',
  'a > b < c',
  '&amp; already',
  'Quote "q" \'s\'',
  '\u00e9\u{1F600}\u0131',
  'two\nlines',
  '\u00a0nbsp',
]

const pdfScript = (extra: Script = {}): Script => ({ pdfHex: '255044462d', ...extra })

// ---------- cases: headless-export ----------

const ARGV_CASES: string[][] = [
  [],
  ['app'],
  ['app', '--json'],
  ['app', '--headless-export'],
  ['app', '--headless-export', '--json'],
  ['app', '--headless-export', 'in.docx'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out', 'out.pdf'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out', 'out.pdf', '--json'],
  ['app', '--json', '--headless-export', 'in.docx', '--out', 'o.html', '--to', 'HTML'],
  ['app', '--headless-export=in.docx', '--to=pdf', '--out=o.pdf'],
  ['app', '--headless-export=', '--to=pdf', '--out=o.pdf'],
  ['app', '--headless-export', '', '--to=pdf', '--out=o.pdf'],
  ['app', '--headless-export', 'a', '--headless-export', 'b', '--to', 'pdf', '--out', 'o'],
  ['app', '--headless-export', '--to', 'pdf', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to'],
  ['app', '--headless-export', 'in.docx', '--to', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to=', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'exe', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'PDF', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'Drawio.SVG', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'dio', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'drawio.png', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'p\u0131f', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', '\u212Aml', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'S\u017Fg', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out', '--json'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out='],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out', ''],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--page', '2'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page=3'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page', '0'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page', '-1'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page', '1.5'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page', 'x'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page', ''],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page=0x10'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page=1e2'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page= 7 '],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page=3.0'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page=9007199254740991'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page=9007199254740992'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page', 'Infinity'],
  ['app', '--headless-export', 'in.drawio', '--to', 'png', '--out', 'o', '--page'],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--ops', 'ops.json'],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--ops='],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--ops'],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--ops', '--json'],
  [
    'app',
    '--headless-export',
    'in.drawio',
    '--to',
    'drawio',
    '--out',
    'o',
    '--batch',
    'best-effort',
  ],
  [
    'app',
    '--headless-export',
    'in.drawio',
    '--to',
    'drawio',
    '--out',
    'o',
    '--batch=stop-on-error',
  ],
  [
    'app',
    '--headless-export',
    'in.drawio',
    '--to',
    'drawio',
    '--out',
    'o',
    '--batch',
    'all-or-nothing',
  ],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--batch', 'nope'],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--batch='],
  ['app', '--headless-export', 'in.drawio', '--to', 'drawio', '--out', 'o', '--batch'],
  [
    'app',
    '--headless-export',
    'in.drawio',
    '--to',
    'drawio',
    '--out',
    'o',
    '--batch',
    'BEST-EFFORT',
  ],
  [
    'app',
    '--headless-export',
    'in.drawio',
    '--to',
    'drawio',
    '--out',
    'o',
    '--page',
    '4',
    '--ops',
    'o.json',
    '--batch',
    'best-effort',
    '--json',
  ],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out', 'o', '--out', 'p'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out', 'o', '--unknown', 'x', '--json'],
  ['app', '--headless-export', 'in.docx', '--total', 'x', '--to', 'pdf', '--out', 'o'],
  ['app', '--headless-export', '-x', '--to', 'pdf', '--out', '-y'],
  ['app', '--headless-export', 'caf\u00e9.docx', '--to', 'pdf', '--out', 'o\u{1F600}.pdf'],
  ['app', '--headless-exports', 'in.docx'],
  ['--headless-export', 'in.docx', '--to', 'md', '--out', 'o.md'],
  ['app', '--json', '--json'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf', '--out', 'o', 'extra'],
  ['app', '--headless-export', 'in.docx', '--to', 'pdf=x', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--to=pdf', '--to=svg', '--out', 'o'],
  ['app', '--headless-export', 'in.docx', '--out', 'o', '--to', '--json'],
]

const OK = (extra: Record<string, unknown> = {}): HeadlessExportOutcome =>
  ({ ok: true, input: 'in.docx', outPath: 'out.pdf', ...extra }) as HeadlessExportOutcome
const FAIL = (code: 1 | 2 | 3, message: string): HeadlessExportOutcome => ({
  ok: false,
  code,
  message,
})

const OUTCOMES: HeadlessExportOutcome[] = [
  OK(),
  OK({ outPaths: [] }),
  OK({ outPaths: ['a.png'] }),
  OK({ outPaths: ['a.png', 'b.png'] }),
  OK({ outPaths: null }),
  OK({
    outPaths: ['p1', 'p2', 'p3'],
    detail: { ops: [{ id: 1, ok: true }], n: 2.5, '2': 'b', '10': 'c', a: null },
  }),
  OK({ detail: {} }),
  OK({ detail: null }),
  OK({ detail: { text: 'caf\u00e9 \u{1F600} "q" \\ \n' } }),
  OK({ input: 'a\nb.docx', outPath: 'o\r\nut.pdf' }),
  OK({ outPaths: [], detail: { x: 1 } }),
  FAIL(1, 'bad args'),
  FAIL(2, 'cannot read input'),
  FAIL(3, 'line one\nline two\r\nline three \r\n\r\n  four  '),
  FAIL(3, '  \n  '),
  FAIL(3, ''),
  FAIL(2, 'tab\tkept \u00a0\n\u00a0x \u2028 y'),
  FAIL(1, 'caf\u00e9 \u{1F600}'),
]

// ---------- cases: generate-handoff ----------

const T0 = 1_700_000_000_000
const GH = (
  id: string,
  target: 'slides' | 'html' | 'mindmap',
  paths: string[] = ['/m/a.docx', '/m/b.pdf'],
  text = 'make it',
): GenerateHandoff => ({
  id,
  mode: 'ai',
  target,
  materials: paths.map((path, i) => ({ path, name: `file${i}` })),
  text,
  defaultText: false,
  createdAt: T0,
})
const SH = (
  id: string,
  target: HandoffEditor,
  extra: { preview?: Record<string, unknown>; attach?: string[] } = {},
): SkillHandoff => ({
  id,
  mode: 'skill',
  target,
  text: 'use the skill',
  chips: [{ id: 'c1', source: 'user', title: 'Chip' }],
  ...(extra.preview ? { preview: extra.preview as unknown as SkillHandoff['preview'] } : {}),
  ...(extra.attach ? { attach: extra.attach } : {}),
  createdAt: T0,
})
const step = (op: string, ...args: unknown[]) => ({ op, args })

const PREVIEW = {
  previewId: 'p1',
  title: 'T',
  fileName: 'f.docx',
  originalRedacted: false,
  proposal: { a: 1, b: [2, 3] },
  draft: { x: 'y' },
}

type Step = { op: string; args: unknown[] }

async function handoffRun(name: string, a: unknown[], cx: TsContext): Promise<unknown> {
  handoff.resetGenerateHandoffsForTest()
  const listeners: { id: number; fn: () => void }[] = []
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const realNow = Date.now
  Date.now = () => cx.now
  const contentsOf = (spec: { id: number; destroyed?: boolean }) => ({
    id: spec.id,
    isDestroyed: () => spec.destroyed === true,
    once: (_event: 'destroyed', fn: () => void) => {
      listeners.push({ id: spec.id, fn })
    },
  })
  const apply = (op: string, args: unknown[]): unknown => {
    switch (op) {
      case 'queueGenerateHandoff':
        return handoff.queueGenerateHandoff(args[0] as number, args[1] as GenerateHandoff)
      case 'queueGenerateHandoffFor':
        return handoff.queueGenerateHandoffFor(
          contentsOf(args[0] as { id: number }),
          args[1] as GenerateHandoff,
        )
      case 'takeGenerateHandoff':
        return handoff.takeGenerateHandoff(args[0] as 'slides', args[1] as number)
      case 'dropGenerateHandoff':
        return handoff.dropGenerateHandoff(args[0] as number)
      case 'queueSkillHandoff':
        return handoff.queueSkillHandoff(args[0] as number, args[1] as SkillHandoff)
      case 'queueSkillHandoffFor':
        return handoff.queueSkillHandoffFor(
          contentsOf(args[0] as { id: number }),
          args[1] as SkillHandoff,
        )
      case 'takeSkillHandoff':
        return handoff.takeSkillHandoff(args[0] as HandoffEditor, args[1] as number)
      case 'queuedSkillHandoffs':
        return handoff.queuedSkillHandoffs()
      case 'queuedGenerateHandoffs':
        return handoff.queuedGenerateHandoffs()
      case 'setGenerateTabIdResolver': {
        const spec = args[0] as {
          table: Record<string, string>
          throwsFor?: number[]
        } | null
        return handoff.setGenerateTabIdResolver(
          spec === null
            ? null
            : (id: number) => {
                if (spec.throwsFor?.includes(id)) throw new Error('resolver boom')
                return spec.table[String(id)]
              },
        )
      }
      case 'reportGenerateRunStarted':
        return handoff.reportGenerateRunStarted(
          args[0] as 'slides',
          args[1] as number,
          args[2] as string[],
        )
      case 'generateRunStartedEvents':
        return handoff.generateRunStartedEvents()
      case 'recordGenerateConverted':
        return handoff.recordGenerateConverted(
          args[0] as Parameters<typeof handoff.recordGenerateConverted>[0],
        )
      case 'generateConvertedEvents':
        return handoff.generateConvertedEvents()
      case 'resetGenerateHandoffsForTest':
        return handoff.resetGenerateHandoffsForTest()
      case 'emitDestroyed': {
        for (let at = listeners.findIndex((l) => l.id === args[0]); at >= 0;) {
          const [listener] = listeners.splice(at, 1)
          listener!.fn()
          at = listeners.findIndex((l) => l.id === args[0])
        }
        return undefined
      }
      case 'setPlatform':
        Object.defineProperty(process, 'platform', { value: args[0], configurable: true })
        return undefined
      default:
        throw new Error(`unknown op ${op}`)
    }
  }
  try {
    for (const s of a[0] as Step[]) apply(s.op, s.args)
    const result = apply(name, a.slice(1))
    return {
      result,
      state: {
        queued: handoff.queuedGenerateHandoffs(),
        skill: handoff.queuedSkillHandoffs(),
        runs: handoff.generateRunStartedEvents(),
        converted: handoff.generateConvertedEvents(),
      },
    }
  } finally {
    Date.now = realNow
    Object.defineProperty(process, 'platform', platform)
    handoff.resetGenerateHandoffsForTest()
  }
}

const handoffFn = (name: string, cases: unknown[][]) => ({
  ts: (a: unknown[], cx: TsContext) => handoffRun(name, a, cx),
  cases: cases.map((args): Case => ({ args })),
})

const CONVERT = (id: number, sources: unknown[], extra: Record<string, unknown> = {}) => ({
  webContentsId: id,
  target: 'markdown',
  kind: 'mindmap-to-markdown',
  sources,
  conversionId: `conv-${id}`,
  ...extra,
})

/** `n` hand-offs queued, taken and reported, each in its own tab */
const manyRuns = (n: number): Step[] =>
  Array.from({ length: n }, (_, i) => [
    step('queueGenerateHandoff', i, GH(`h${i}`, 'slides', [`/p/a${i}`, '/p/shared'])),
    step('takeGenerateHandoff', 'slides', i),
    step('reportGenerateRunStarted', 'slides', i, [`/p/a${i}`]),
  ]).flat()

const manyConverted = (n: number): Step[] =>
  Array.from({ length: n }, (_, i) => step('recordGenerateConverted', CONVERT(i, [`/c/${i}`])))

// ---------- helper runs of the renderer-side functions ----------

interface PollSpec {
  readyAfter: number
  stall: string
  lazy?: boolean
  timeoutMs?: number | null
  pollMs?: number | null
  options?: boolean
}

async function pollRun(spec: PollSpec, cx: TsContext): Promise<void> {
  let clock = cx.now
  const realNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  Date.now = () => clock
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    cx.log('setTimeout', ms)
    clock += ms
    setImmediate(fn)
    return 0
  }) as unknown as typeof setTimeout
  let calls = 0
  const ready = (): boolean => {
    cx.log('ready')
    const n = calls++
    return spec.readyAfter >= 0 && n >= spec.readyAfter
  }
  const stall = spec.lazy
    ? () => {
        cx.log('stall')
        return spec.stall
      }
    : spec.stall
  const options =
    spec.options === false
      ? undefined
      : { timeoutMs: orUndefined(spec.timeoutMs), pollMs: orUndefined(spec.pollMs) }
  try {
    await pollUntilReady(ready, stall, options)
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realSetTimeout
  }
}

interface FontsSpec {
  dom: 'none' | 'nofonts' | 'fonts'
  fontsWin?: boolean
  timeoutMs?: number | null
}

async function fontsRun(spec: FontsSpec, cx: TsContext): Promise<string> {
  const sentinel = { fonts: true }
  const g = globalThis as unknown as Record<string, unknown>
  const hadDocument = 'document' in g
  const realDocument = g.document
  const realSetTimeout = globalThis.setTimeout
  let timerSet = false
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    timerSet = true
    cx.log('setTimeout', ms)
    setImmediate(fn)
    return 0
  }) as unknown as typeof setTimeout
  if (spec.dom === 'none') delete g.document
  else if (spec.dom === 'nofonts') g.document = {}
  else
    g.document = {
      fonts: { ready: spec.fontsWin ? Promise.resolve(sentinel) : new Promise(() => undefined) },
    }
  try {
    const settled = await documentFontsSettled(orUndefined(spec.timeoutMs))
    return settled === sentinel ? 'fonts' : timerSet ? 'timeout' : 'immediate'
  } finally {
    globalThis.setTimeout = realSetTimeout
    if (hadDocument) g.document = realDocument
    else delete g.document
  }
}

interface RendererSpec {
  wait?: { throws?: string; throwsString?: string }
  export?: boolean | { throws?: string; throwsString?: string }
}

const thrown = (spec: { throws?: string; throwsString?: string } | undefined): unknown => {
  if (spec?.throws !== undefined) return new Error(spec.throws)
  return spec?.throwsString
}

async function rendererRun(outPath: string, spec: RendererSpec, cx: TsContext) {
  return runHeadlessRendererExport(
    outPath,
    async () => {
      cx.log('wait')
      if (spec.wait && (spec.wait.throws !== undefined || spec.wait.throwsString !== undefined))
        throw thrown(spec.wait)
    },
    async (path) => {
      cx.log('export', path)
      const out = spec.export
      if (typeof out === 'object' && (out.throws !== undefined || out.throwsString !== undefined))
        throw thrown(out)
      return out === true
    },
  )
}

const MODULE_PATHS = [
  'a.docx',
  'A.DOCX',
  'a.docx\n',
  'a.Docx ',
  'a.doc',
  'a.xlsx',
  'a.XLSM',
  'a.xls',
  'a.csv',
  'a.tsv',
  'a.pptx',
  'a.ppt',
  'a.md',
  'a.markdown',
  'a.MarkDown',
  'a.html',
  'a.htm',
  'a.hwp',
  'a.hwpx',
  'a.hwpxx',
  'a.drawio',
  'a.dio',
  'a.drawio.svg',
  'a.DRAWIO.PNG',
  'a.svg',
  'a.png',
  'a.pdf',
  'a.txt',
  'docx',
  '.docx',
  '',
  '/dir.d/noext',
  'C:\\docs\\a.docx',
  '\u00fcn\u00ef\u{1F600}.docx',
  'a.xl\u017Fx',
  'a.\u017Fvg',
  'a.m\u212A',
  'a.mar\u212Adown',
  'a.\u0131tml',
  'a.HTM\u0130',
  'a.cs\u017F',
  'a.dio\u2028',
]

// ---------- the group ----------

export const group: Group = {
  // ---------- printer-options.ts ----------
  'printer-options.DRIVER_OPTION_NAMES': {
    ts: () => [...DRIVER_OPTION_NAMES],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'printer-options.isValidOptionName': {
    ts: (a) => isValidOptionName(a[0]),
    cases: [...OPTION_TEXTS.map((t) => [t]), [5], [null], [undefined], [['a']], [{}], [true]].map(
      (args): Case => ({ args }),
    ),
  },
  'printer-options.isValidOptionValue': {
    ts: (a) => isValidOptionValue(a[0]),
    cases: [...OPTION_TEXTS.map((t) => [t]), [5], [null], [undefined], [['a']], [{}], [false]].map(
      (args): Case => ({ args }),
    ),
  },
  'printer-options.parseLpOptions': { ts: (a) => parseLpOptions(str(a, 0)), cases: lpCases },
  'printer-options.queryPrinterOptions': {
    ts: (a, cx) => queryPrinterOptions(str(a, 0), fakeExecFile(a[1] as Table, cx.log)),
    cases: cases(
      ['Office', { [LP_QUERY]: { stdout: LPOPTIONS } }],
      ['Office', { [LP_QUERY]: { stdout: LPOPTIONS, code: 1 } }],
      ['Office', { [LP_QUERY]: { stdout: LPOPTIONS, code: null } }],
      ['Office', { [LP_QUERY]: { error: 'spawn ENOENT' } }],
      ['Office', { [LP_QUERY]: { stdout: '' } }],
      ['Office', { [LP_QUERY]: {} }],
      ['Office', {}],
      ['Other', { [LP_QUERY]: { stdout: LPOPTIONS } }],
      [
        'My Printer',
        { '/usr/bin/lpoptions -p My Printer -l': { stdout: 'ColorModel/Color: *RGB Gray\n' } },
      ],
      ['', { '/usr/bin/lpoptions -p  -l': { stdout: 'MediaType/Type: a *b\n' } }],
      [
        'caf\u00e9\u{1F600}',
        { '/usr/bin/lpoptions -p caf\u00e9\u{1F600} -l': { stdout: 'N/T\u00e9: \u00e9 *a\n' } },
      ],
    ),
  },

  // ---------- print-cups.ts ----------
  'print-cups.lpArgumentsFor': {
    ts: (a) => lpArgumentsFor(a[0] as CupsPrintJob),
    cases: cases(
      [{}],
      [{ deviceName: 'Office' }],
      [{ deviceName: '' }],
      [{ deviceName: 'My Printer \u00e9\u{1F600}' }],
      [{ copies: 1 }],
      [{ copies: 0 }],
      [{ copies: -2 }],
      [{ copies: 2.5 }],
      [{ copies: 1e21 }],
      [{ copies: 123456789 }],
      [{ collate: true }],
      [{ collate: false }],
      [{ duplexMode: 'simplex' }],
      [{ duplexMode: 'longEdge' }],
      [{ duplexMode: 'shortEdge' }],
      [{ driverOptions: [] }],
      [
        {
          driverOptions: [
            { name: 'ColorModel', value: 'Gray' },
            { name: 'MediaType', value: 'Plain' },
          ],
        },
      ],
      [
        {
          driverOptions: [
            { name: 'bad name', value: 'x' },
            { name: 'ok', value: '' },
            { name: A64, value: A64 },
            { name: `${A64}a`, value: 'v' },
            { name: 'ok', value: 'v\n' },
            { name: 'caf\u00e9', value: 'v' },
            { name: 'k\u212A', value: 'v' },
          ],
        },
      ],
      [
        {
          deviceName: 'Q',
          copies: 3,
          collate: true,
          duplexMode: 'shortEdge',
          driverOptions: [{ name: 'cupsPrintQuality', value: 'High' }],
        },
      ],
      [{ copies: 2, deviceName: 'Q', duplexMode: 'longEdge', collate: false }],
    ),
  },
  'print-cups.printToPdfOptionsFor': {
    ts: (a) => printToPdfOptionsFor(a[0] as PrintToPdfRequest),
    cases: cases(
      [{}],
      [{ printBackground: false }],
      [{ printBackground: true }],
      [{ widthIn: 8.27, heightIn: 11.69 }],
      [{ widthIn: 8.27 }],
      [{ heightIn: 11 }],
      [{ widthIn: 0, heightIn: 0 }],
      [{ widthIn: -1.5, heightIn: 1e21 }],
      [{ landscape: true }],
      [{ landscape: false }],
      [{ scale: 1 }],
      [{ scale: 0.5 }],
      [{ scale: 0 }],
      [{ scale: 2.25 }],
      [{ marginsIn: { top: 1, bottom: 1, left: 0.5, right: 0.5 } }],
      [{ marginsIn: { top: 0, bottom: 0, left: 0, right: 0 } }],
      [{ marginsIn: { right: 0.25, left: 0.5, bottom: 1, top: 2, extra: 'x' } }],
      [
        {
          widthIn: 11,
          heightIn: 8.5,
          landscape: true,
          marginsIn: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
          scale: 0.75,
          printBackground: false,
        },
      ],
    ),
  },
  'print-cups.printPdfViaCups': {
    ts: (a, cx) =>
      printPdfViaCups(
        new TextEncoder().encode(str(a, 0)),
        a[1] as CupsPrintJob,
        fakeSpawn(a[2] as Table, cx.log),
      ),
    cases: [
      cupsRun('%PDF-1.4', {}, { [CUPS_FAIL]: { code: 0 } }, 'accepted'),
      cupsRun(
        '%PDF-1.4',
        {},
        { [CUPS_FAIL]: { code: 0, stdout: 'request id is Q-1 (0 file(s))' } },
        'stdout ignored on success',
      ),
      cupsRun(
        '',
        { deviceName: 'Office', copies: 2, duplexMode: 'longEdge' },
        { '/usr/bin/lp -d Office -n 2 -o sides=two-sided-long-edge': { code: 0 } },
        'an empty document',
      ),
      cupsRun(
        'pdf \u00e9\u{1F600}',
        { deviceName: 'Q', collate: true, driverOptions: [{ name: 'ColorModel', value: 'Gray' }] },
        { '/usr/bin/lp -d Q -o Collate=True -o ColorModel=Gray': { code: 0 } },
        'non-ASCII bytes',
      ),
      cupsRun(
        'x',
        { deviceName: 'Missing' },
        {
          '/usr/bin/lp -d Missing': {
            code: 1,
            stderr: '  lp: Error - The printer or class does not exist.\n',
          },
        },
        'stderr message trimmed',
      ),
      cupsRun(
        'x',
        {},
        { [CUPS_FAIL]: { code: 1, stderr: '  \n', stdout: ' from stdout \n' } },
        'blank stderr falls to stdout',
      ),
      cupsRun('x', {}, { [CUPS_FAIL]: { code: 2 } }, 'exit code message'),
      cupsRun(
        'x',
        {},
        { [CUPS_FAIL]: { code: 1, stderr: '\u00a0\ufeff\n', stdout: '\t' } },
        'JS white space only',
      ),
      cupsRun('x', {}, { [CUPS_FAIL]: { code: null } }, 'killed by a signal'),
      cupsRun(
        'x',
        {},
        { [CUPS_FAIL]: { code: 127, stderr: 'caf\u00e9 \u{1F600} err' } },
        'non-ASCII stderr',
      ),
      cupsRun('x', {}, { [CUPS_FAIL]: { error: 'spawn /usr/bin/lp ENOENT' } }, 'spawn error'),
      cupsRun('x', {}, { [CUPS_FAIL]: { error: '' } }, 'spawn error with no message'),
      cupsRun('x', { deviceName: 'Nobody' }, {}, 'no such command'),
      cupsRun('x', { copies: -1 }, { '/usr/bin/lp -n -1': { code: 0 } }, 'negative copies'),
    ],
  },

  // ---------- print-job.ts ----------
  'print-job.printJobOptions': {
    ts: (a) => printJobOptions(a[0]),
    cases: jobCases.map((args): Case => ({ args })),
  },
  'print-job.printOutcome': {
    ts: (a) => printOutcome(a[0] as boolean, orUndefined(a[1] as string | null), a[2] as boolean),
    cases: cases(
      [true, null, false],
      [true, 'ignored', true],
      [false, null, false],
      [false, null, true],
      [false, '', false],
      [false, '', true],
      [false, 'Print job canceled', false],
      [false, 'Print job canceled', true],
      [false, 'CANCELLED', false],
      [false, 'Cancel', false],
      [false, 'xcancelx', true],
      [false, 'canc\u0065l', false],
      [false, 'cance\u0131', false],
      [false, 'C\u0041NCEL', false],
      [false, 'Failed to open printer', false],
      [false, 'Failed to open printer', true],
      [false, 'cancel \u00e9\u{1F600}', false],
    ),
  },

  // ---------- print-window.ts ----------
  'print-window.PRINT_READY_SCRIPT': {
    ts: () => PRINT_READY_SCRIPT,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'print-window.loadPrintHtml': {
    ts: (a, cx) =>
      withProbe(cx, () =>
        masked(async () => {
          const win = dialogWindow(a[3] as Script, cx.log)
          const { tempDir } = await loadPrintHtml(
            win,
            str(a, 0),
            orUndefined(a[1] as string | null),
            orUndefined(a[2] as string | null),
          )
          const files = readdirSync(tempDir)
            .sort()
            .map((name) => [name, readFileSync(`${tempDir}/${name}`, 'utf8')])
          rmSync(tempDir, { recursive: true, force: true })
          const base = tempDir.slice(tempDir.lastIndexOf('/') + 1)
          return {
            tempDir: base.slice(0, -6),
            inTmpdir: tempDir.slice(0, tempDir.lastIndexOf('/')) === tmpdir(),
            files,
          }
        }),
      ),
    cases: cases(
      ['<p>hi</p>', null, null, {}],
      ['<p>caf\u00e9 \u{1F600}</p>', 'doc \u00e9.html', 'zz-', {}],
      ['', null, null, {}],
      ['<p>x</p>', 'a.html', null, { exec: 'rejected' }],
      ['<p>x</p>', null, null, { exec: 'pending' }],
      ['<p>x</p>', null, null, { exec: 'throws' }],
      ['<p>x</p>', null, null, { loadFile: 'throws' }],
      ['<p>x</p>', '', null, {}],
      ['<p>x</p>', null, 'no-such-dir/zz-', {}],
      ['<p>x</p>', 'missing-dir/x.html', null, {}],
    ),
  },
  'print-window.printHtmlDocument': {
    ts: (a, cx) =>
      withProbe(cx, () =>
        masked(() =>
          printHtmlDocument({
            html: str(a, 0),
            window: dialogWindow(a[4] as Script, cx.log),
            fileName: orUndefined(a[1] as string | null),
            dirPrefix: orUndefined(a[2] as string | null),
            platform: orUndefined(a[3] as NodeJS.Platform | null),
          }),
        ),
      ),
    cases: cases(
      ['<p>x</p>', null, null, 'linux', { print: { success: true } }],
      ['<p>x</p>', null, null, 'darwin', { print: { success: true } }],
      ['<p>x</p>', null, null, 'win32', { print: { success: true } }],
      ['<p>x</p>', null, null, null, { print: { success: true } }],
      ['<p>x</p>', 'my doc.html', 'zz-', 'linux', { print: { success: true } }],
      [
        '<p>x</p>',
        null,
        null,
        'linux',
        { print: { success: false, reason: 'Print job canceled' } },
      ],
      [
        '<p>x</p>',
        null,
        null,
        'linux',
        { print: { success: false, reason: 'print job canceled' } },
      ],
      ['<p>x</p>', null, null, 'linux', { print: { success: false, reason: 'Driver failure' } }],
      ['<p>x</p>', null, null, 'linux', { print: { success: false, reason: '' } }],
      ['<p>x</p>', null, null, 'linux', { print: { success: false } }],
      ['<p>x</p>', null, null, 'linux', {}],
      ['<p>x</p>', null, null, 'linux', { loadFile: 'throws' }],
      ['<p>x</p>', null, null, 'linux', { exec: 'rejected', print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { exec: 'pending', print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { exec: 'throws', print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { print: 'throws' }],
      ['<p>x</p>', null, null, 'win32', { showThrows: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'win32', { focusThrows: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { destroyed: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { destroyThrows: true, print: { success: true } }],
      ['<p>x</p>', null, null, 'linux', { isDestroyedThrows: true, print: { success: true } }],
      ['<p>x</p>', '', null, 'linux', { print: { success: true } }],
      ['<p>x</p>', 'missing-dir/x.html', null, 'linux', { print: { success: true } }],
      ['<p>x</p>', null, 'no-such-dir/zz-', 'linux', { print: { success: true } }],
      ['<p>caf\u00e9 \u{1F600}</p>', 'caf\u00e9.html', null, 'linux', { print: { success: true } }],
    ),
  },

  // ---------- print-html-pdf.ts ----------
  'print-html-pdf.sanitizePrintableBody': {
    ts: (a) => sanitizePrintableBody(str(a, 0)),
    cases: FRAGMENTS.map((html): Case => ({ args: [html] })),
  },
  'print-html-pdf.buildPrintableHtml': {
    ts: (a) => buildPrintableHtml(str(a, 0), str(a, 1)),
    cases: [
      ...TITLES.map((title): Case => ({ args: [title, '<p>body</p>'] })),
      ...FRAGMENTS.slice(0, 30).map((html): Case => ({ args: ['T', html] })),
    ],
  },
  'print-html-pdf.printHtmlToPdf': {
    ts: async (a, cx) => {
      let workDir: string | undefined
      const window = (script: Script): PrintWindow => ({
        async loadFile(path: string) {
          workDir = dirname(path)
          logLoad(path, cx.log)
          if (script.loadFile === 'throws') throw new Error('load failed')
        },
        webContents: {
          async printToPDF(options) {
            cx.log('printToPDF', options)
            if (script.printToPDF === 'throws') throw new Error('printToPDF threw')
            return Buffer.from(script.pdfHex ?? '', 'hex')
          },
        },
        destroy() {
          cx.log('destroy')
          if (script.destroyThrows) throw new Error('destroy threw')
        },
      })
      const script = a[1] as Script
      try {
        return await masked(async () =>
          (
            await printHtmlToPdf(str(a, 0) as PrintableHtml, () => {
              cx.log('createWindow')
              if (script.createWindow === 'throws') throw new Error('createWindow threw')
              return window(script)
            })
          ).toString('hex'),
        )
      } finally {
        if (workDir) rmSync(workDir, { recursive: true, force: true })
      }
    },
    cases: cases(
      ['<html><body>x</body></html>', pdfScript()],
      ['', pdfScript({ pdfHex: '' })],
      ['<p>caf\u00e9 \u{1F600}</p>', pdfScript({ pdfHex: '00ff10' })],
      ['<p>x</p>', pdfScript({ createWindow: 'throws' })],
      ['<p>x</p>', pdfScript({ loadFile: 'throws' })],
      ['<p>x</p>', pdfScript({ printToPDF: 'throws' })],
      ['<p>x</p>', pdfScript({ destroyThrows: true })],
      ['<p>x</p>', pdfScript({ loadFile: 'throws', destroyThrows: true })],
    ),
  },
  /** `serialize(parseFragment(html))`: parse5's own, to compare the whole serializer */
  'print-html-pdf.parseSerialize': {
    ts: (a) => serialize(parseFragment(str(a, 0))),
    cases: [
      ...FRAGMENTS,
      '<a href="x&amp;y" title=\'he said "hi"\' data-x=1 class=a class=b>t</a>',
      '<p id="a&quot;b" title="&lt;&gt;&nbsp;&amp;">x</p>',
      '<p title=\u00e9\u{1F600}\u00a0x>y</p>',
      '<img src=x alt="&nbsp;"><input disabled value="">',
      '<p a=1 B=2 C="3" d=\'4\' e>x</p>',
      '<p a\u0000b="v\u0000w">x</p>',
      '<p a=&notit; b=&amp c=&copy=1 d="&copy=1">x</p>',
      '<svg viewBox="0 0 1 1" xlink:href="#a" xml:lang="en" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:foo="x" foo:bar="1"><clippath/><foreignobject><p>x</p></foreignobject></svg>',
      '<svg><title><p>x</p></title><desc>d</desc></svg>',
      '<svg><path d="M0 0"/><circle r=1 /></svg>',
      '<math><mi mathvariant=bold>x</mi><annotation-xml encoding="text/html"><p>x</p></annotation-xml></math>',
      '<template><p>x</p><td>y</template>',
      '<template><template><b>n</b></template></template>',
      '<template>&amp;<</template>',
      '<p><template>t</template></p>',
      '<noscript><p>x</p>&amp;</noscript>',
      '<style>a<b && c>d { }</style>',
      '<script>if (a<b && c>d) { x = "&amp;" }</script>',
      '<xmp><b>&amp;</xmp>',
      '<iframe><p>&amp;</iframe>',
      '<noembed><p>x</noembed>',
      '<noframes><p>x</noframes>',
      '<plaintext><b>&amp;x',
      '<textarea><b>&amp;</textarea>',
      '<title>a&lt;b</title>',
      '<p>a &amp; b &lt; c &gt; d &quot; e &nbsp; f</p>',
      '<basefont><bgsound><keygen><command><source><track><param><area><col>',
      '<br><br/></br>',
      '<!--a--><!----><!-- b -->',
      '<p><!--c--></p>',
      '<menuitem>m</menuitem><dialog open>d</dialog>',
      '<table><tr><td>a<td>b</table>',
      '<table><caption>c<tr><td>x',
      '<select><option>a<optgroup label=g><option>b</select>',
      '<ruby>a<rp>(<rt>b<rp>)</ruby>',
      '<p>\uFEFF<b>\u00a0</b></p>',
      '<a href=x><b><a href=y>z</b></a>',
      '<form><form>x</form></form>',
      '<ul><li><p>a<li>b</ul>',
      '<font color=red><p>x</font>y',
      '<p>a\r\nb</p>',
      '<p title="a\r\nb">x</p>',
    ].map((html): Case => ({ args: [html] })),
  },

  // ---------- headless-mode.ts ----------
  'headless-mode.setHeadlessMode': {
    ts: (a) => {
      setHeadlessMode(a[0] as boolean)
      const now = isHeadlessMode()
      setHeadlessMode(false)
      return now
    },
    cases: cases([true], [false]),
  },
  'headless-mode.isHeadlessMode': {
    ts: (a) => {
      setHeadlessMode(a[0] as boolean)
      const now = isHeadlessMode()
      setHeadlessMode(false)
      return now
    },
    cases: cases([true], [false]),
  },

  // ---------- handoff-editors.ts ----------
  'handoff-editors.HANDOFF_EDITORS': {
    ts: () => [...HANDOFF_EDITORS],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'handoff-editors.isHandoffEditor': {
    ts: (a) => isHandoffEditor(a[0]),
    cases: cases(
      ...[
        ...HANDOFF_EDITORS,
        'DOCS',
        'doc',
        'docs ',
        ' docs',
        '',
        'constructor',
        'toString',
        '__proto__',
        'length',
        '0',
        'docs\n',
        'd\u00f6cs',
        '\u212Aml',
        'epub\u0000',
      ].map((v) => [v]),
      [5],
      [null],
      [undefined],
      [['docs']],
      [{}],
      [true],
    ),
  },
  'handoff-editors.HANDOFF_ATTACH_EDITORS': {
    ts: () => [...HANDOFF_ATTACH_EDITORS],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'handoff-editors.handoffEditorTakesAttachments': {
    ts: (a) => handoffEditorTakesAttachments(a[0] as HandoffEditor),
    cases: cases(
      ...[...HANDOFF_EDITORS, 'DOCS', '', 'constructor', 'unknown', 'length', '0'].map((v) => [v]),
      [5],
      [null],
      [['docs']],
    ),
  },

  // ---------- headless-export.ts ----------
  'headless-export.DIAGRAM_FILE_TARGETS': {
    ts: () => [...DIAGRAM_FILE_TARGETS],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'headless-export.DIAGRAM_BATCH_MODES': {
    ts: () => [...DIAGRAM_BATCH_MODES],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'headless-export.HEADLESS_TARGETS': {
    ts: () => HEADLESS_TARGETS,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'headless-export.isDiagramFileTarget': {
    ts: (a) => isDiagramFileTarget(a[0] as HeadlessExportFormat),
    cases: cases(
      ...[
        ...DIAGRAM_FILE_TARGETS,
        'pdf',
        'png',
        'svg',
        'DRAWIO',
        'drawio ',
        '',
        'drawio.svg\n',
        'length',
        'constructor',
        'drawi\u00f3',
      ].map((v) => [v]),
      [5],
      [null],
      [['drawio']],
    ),
  },
  'headless-export.HEADLESS_EXPORT_FLAG': {
    ts: () => HEADLESS_EXPORT_FLAG,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'headless-export.HEADLESS_EXIT': {
    ts: () => HEADLESS_EXIT,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'headless-export.headlessModuleFor': {
    ts: (a) => headlessModuleFor(str(a, 0)),
    cases: MODULE_PATHS.map((p): Case => ({ args: [p] })),
  },
  'headless-export.HEADLESS_SUPPORTED_EXTENSIONS': {
    ts: () => HEADLESS_SUPPORTED_EXTENSIONS,
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'headless-export.parseHeadlessExportArgv': {
    ts: (a) => parseHeadlessExportArgv(a[0] as string[]),
    cases: ARGV_CASES.map((argv): Case => ({ args: [argv] })),
  },
  'headless-export.headlessSummary': {
    ts: (a) => headlessSummary(a[0] as HeadlessExportOutcome),
    cases: OUTCOMES.map((o): Case => ({ args: [o] })),
  },
  'headless-export.formatHeadlessEnvelope': {
    ts: (a) => formatHeadlessEnvelope(a[0] as HeadlessExportOutcome, a[1] as boolean),
    cases: OUTCOMES.flatMap((o): Case[] => [{ args: [o, false] }, { args: [o, true] }]),
  },
  'headless-export.headlessExitCode': {
    ts: (a) => headlessExitCode(a[0] as HeadlessExportOutcome),
    cases: [
      ...OUTCOMES,
      FAIL(1, 'x'),
      { ok: false, code: 3, message: 'm' } as HeadlessExportOutcome,
    ].map((o): Case => ({ args: [o] })),
  },
  'headless-export.headlessSleep': {
    ts: async (a, cx) => {
      const realSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = ((fn: () => void, ms: number) => {
        cx.log('setTimeout', ms)
        setImmediate(fn)
        return 0
      }) as unknown as typeof setTimeout
      try {
        await headlessSleep(a[0] as number)
      } finally {
        globalThis.setTimeout = realSetTimeout
      }
    },
    cases: cases([0], [250], [1.5], [-5], [1e21], [30000]),
  },
  'headless-export.pollUntilReady': {
    ts: (a, cx) => pollRun(a[0] as PollSpec, cx),
    cases: cases(
      [{ readyAfter: 0, stall: 'stuck' }],
      [{ readyAfter: 3, stall: 'stuck' }],
      [{ readyAfter: -1, stall: 'never ready', timeoutMs: 1000, pollMs: 300 }],
      [{ readyAfter: -1, stall: 'never ready', timeoutMs: 1000, pollMs: 250 }],
      [{ readyAfter: -1, stall: 'lazy message', lazy: true, timeoutMs: 100, pollMs: 40 }],
      [{ readyAfter: 2, stall: 'lazy message', lazy: true, timeoutMs: 100, pollMs: 40 }],
      [{ readyAfter: -1, stall: '', timeoutMs: 0, pollMs: 1 }],
      [{ readyAfter: -1, stall: 'zero budget', timeoutMs: 0, pollMs: 0.5 }],
      [{ readyAfter: 1, stall: 'x', timeoutMs: null, pollMs: null }],
      [{ readyAfter: 4, stall: 'x', pollMs: 10 }],
      [{ readyAfter: 1, stall: 'x', options: false }],
      [{ readyAfter: -1, stall: 'negative budget \u00e9\u{1F600}', timeoutMs: -1, pollMs: 5 }],
      [{ readyAfter: 5, stall: 'x', timeoutMs: 50, pollMs: 10 }],
      [{ readyAfter: 6, stall: 'x', timeoutMs: 50, pollMs: 10 }],
    ),
  },
  'headless-export.documentFontsSettled': {
    ts: (a, cx) => fontsRun(a[0] as FontsSpec, cx),
    cases: cases(
      [{ dom: 'none' }],
      [{ dom: 'nofonts' }],
      [{ dom: 'fonts', fontsWin: true }],
      [{ dom: 'fonts', fontsWin: false }],
      [{ dom: 'fonts', fontsWin: false, timeoutMs: 500 }],
      [{ dom: 'fonts', fontsWin: true, timeoutMs: 0 }],
      [{ dom: 'fonts', fontsWin: false, timeoutMs: null }],
    ),
  },
  'headless-export.runHeadlessRendererExport': {
    ts: (a, cx) => rendererRun(str(a, 0), a[1] as RendererSpec, cx),
    cases: cases(
      ['/o/a.pdf', { export: true }],
      ['/o/a.pdf', { export: false }],
      ['/o/a.pdf', {}],
      ['/o/\u00e9\u{1F600}.pdf', { export: true }],
      ['/o/a.pdf', { wait: { throws: 'never opened' }, export: true }],
      ['/o/a.pdf', { wait: { throwsString: 'plain string' }, export: true }],
      ['/o/a.pdf', { wait: { throws: '' }, export: true }],
      ['/o/a.pdf', { export: { throws: 'disk full' } }],
      ['/o/a.pdf', { export: { throwsString: 'oops' } }],
    ),
  },

  // ---------- generate-handoff.ts ----------
  'generate-handoff.handoffEditorForFile': {
    ts: (a) => handoff.handoffEditorForFile(str(a, 0)),
    cases: [
      'a.docx',
      'a.ODT',
      'x.xlsx',
      'x.xlsm',
      'x.xls',
      'x.csv',
      'x.tsv',
      'x.pptx',
      'x.ppt',
      'a.pdf',
      'a.md',
      'a.markdown',
      'a.txt',
      'a.html',
      'a.htm',
      'a.xmind',
      'a.hwp',
      'a.hwpx',
      'a.epub',
      'a.drawio',
      'noext',
      '.docx',
      'a.',
      '.',
      '',
      '/dir.d/file',
      '/dir/a.docx',
      'C:\\dir\\a.PDF',
      'dir/.hidden',
      'dir/.hidden.md',
      'a.b.c.xlsx',
      'a.mar\u212Adown',
      'a.\u212Aml',
      'a.\u0130pdf',
      'a.p\u0131df',
      'caf\u00e9.docx',
      '\u{1F600}.hwpx',
      'a.docx.',
      'a.tx\u017F',
      'a. docx',
      'a.docx ',
      'a.Docx\n',
      'a.\u00e9',
      'dir\\',
      'dir/',
    ].map((v): Case => ({ args: [v] })),
  },
  'generate-handoff.HANDOFF_EDITORS': {
    ts: () => [...handoff.HANDOFF_EDITORS],
    cases: [{ args: [] }],
    single: CONSTANT,
  },
  'generate-handoff.isHandoffEditor': {
    ts: (a) => handoff.isHandoffEditor(a[0]),
    cases: cases(['docs'], ['mindmap'], ['DOCS'], [''], ['constructor'], [5], [null], [['pdf']]),
  },
  'generate-handoff.handoffEditorTakesAttachments': {
    ts: (a) => handoff.handoffEditorTakesAttachments(a[0] as HandoffEditor),
    cases: cases(['docs'], ['pdf'], ['markdown'], ['hwp'], ['epub'], ['nope'], [3]),
  },
  'generate-handoff.queueGenerateHandoff': handoffFn('queueGenerateHandoff', [
    [[], 1, GH('a', 'slides')],
    [[], 2, GH('b', 'html', [])],
    [[step('queueGenerateHandoff', 1, GH('old', 'html'))], 1, GH('new', 'mindmap')],
    [
      [
        step('queueGenerateHandoff', 1, GH('first', 'slides')),
        step('queueGenerateHandoff', 2, GH('second', 'slides')),
      ],
      1,
      GH('replaces-first', 'slides'),
    ],
    [
      [
        step('queueGenerateHandoff', 3, GH('t', 'slides')),
        step('takeGenerateHandoff', 'slides', 3),
      ],
      3,
      GH('after-take', 'slides'),
    ],
    [[], 0, GH('zero', 'slides')],
    [[], -0, GH('neg-zero', 'slides')],
    [
      [step('queueGenerateHandoff', 0, GH('plus', 'slides'))],
      -0,
      GH('minus-zero-replaces', 'html'),
    ],
    [[], 2.5, GH('fraction', 'slides')],
    [[], 10, GH('ten', 'slides')],
    [
      [
        step('queueGenerateHandoff', 10, GH('ten', 'slides')),
        step('queueGenerateHandoff', 2, GH('two', 'slides')),
      ],
      10,
      GH('ten-again', 'html'),
    ],
    [
      [],
      1,
      GH('unicode \u00e9\u{1F600}', 'slides', ['/m/\u00e9\u{1F600}.docx'], 'caf\u00e9 \u{1F600}'),
    ],
  ]),
  'generate-handoff.queueGenerateHandoffFor': handoffFn('queueGenerateHandoffFor', [
    [[], { id: 5 }, GH('live', 'slides')],
    [[], { id: 5, destroyed: true }, GH('gone', 'slides')],
    [
      [step('queueGenerateHandoff', 5, GH('old', 'html'))],
      { id: 5, destroyed: true },
      GH('gone', 'slides'),
    ],
    [
      [step('queueGenerateHandoffFor', { id: 5 }, GH('first', 'slides'))],
      { id: 5 },
      GH('second', 'html'),
    ],
    [
      [
        step('queueGenerateHandoffFor', { id: 5 }, GH('first', 'slides')),
        step('takeGenerateHandoff', 'slides', 5),
      ],
      { id: 5 },
      GH('after-take', 'mindmap'),
    ],
    [
      [step('queueGenerateHandoffFor', { id: 6 }, GH('six', 'slides')), step('emitDestroyed', 6)],
      { id: 6 },
      GH('six-again', 'html'),
    ],
  ]),
  'generate-handoff.takeGenerateHandoff': handoffFn('takeGenerateHandoff', [
    [[], 'slides', 1],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 'slides', 1],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 'html', 1],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 'slides', 2],
    [[step('queueGenerateHandoff', 1, GH('a', 'html'))], 'html', 1],
    [[step('queueGenerateHandoff', 1, GH('a', 'mindmap'))], 'mindmap', 1],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
    ],
    [
      [step('queueGenerateHandoff', 1, GH('a', 'slides')), step('takeGenerateHandoff', 'html', 1)],
      'slides',
      1,
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('queueGenerateHandoff', 2, GH('b', 'html')),
      ],
      'html',
      2,
    ],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 'docs', 1],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 'constructor', 1],
    [[step('queueSkillHandoff', 1, SH('s', 'docs'))], 'slides', 1],
    [
      [step('queueGenerateHandoff', 1, GH('a', 'slides')), step('dropGenerateHandoff', 1)],
      'slides',
      1,
    ],
  ]),
  'generate-handoff.dropGenerateHandoff': handoffFn('dropGenerateHandoff', [
    [[], 1],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 1],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 2],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('queueSkillHandoff', 1, SH('s', 'docs')),
      ],
      1,
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('queueGenerateHandoff', 2, GH('b', 'html')),
      ],
      1,
    ],
    [
      [step('queueSkillHandoff', 4, SH('s', 'pdf')), step('queueSkillHandoff', 5, SH('t', 'pdf'))],
      4,
    ],
  ]),
  'generate-handoff.queueSkillHandoff': handoffFn('queueSkillHandoff', [
    [[], 1, SH('s', 'docs')],
    [[], 1, SH('s', 'sheets', { preview: PREVIEW, attach: ['/m/a.docx'] })],
    [[], 1, SH('s', 'epub', { attach: [] })],
    [[step('queueSkillHandoff', 1, SH('old', 'docs'))], 1, SH('new', 'html')],
    [
      [
        step('queueSkillHandoff', 1, SH('old', 'docs')),
        step('queueSkillHandoff', 2, SH('b', 'pdf')),
      ],
      1,
      SH('new', 'html'),
    ],
    [[step('queueGenerateHandoff', 1, GH('g', 'slides'))], 1, SH('s', 'mindmap')],
    [
      [],
      12,
      SH('s', 'hwp', {
        preview: {
          previewId: 'p',
          title: 't',
          fileName: 'f',
          originalRedacted: true,
          proposal: null,
        },
      }),
    ],
  ]),
  'generate-handoff.queueSkillHandoffFor': handoffFn('queueSkillHandoffFor', [
    [[], { id: 7 }, SH('s', 'docs')],
    [[], { id: 7, destroyed: true }, SH('s', 'docs')],
    [[step('queueSkillHandoff', 7, SH('old', 'pdf'))], { id: 7, destroyed: true }, SH('s', 'docs')],
    [
      [step('queueSkillHandoffFor', { id: 7 }, SH('first', 'pdf')), step('emitDestroyed', 7)],
      { id: 7 },
      SH('again', 'docs'),
    ],
    [
      [step('queueSkillHandoffFor', { id: 7 }, SH('first', 'pdf'))],
      { id: 8 },
      SH('other', 'slides', { attach: ['/x'] }),
    ],
  ]),
  'generate-handoff.takeSkillHandoff': handoffFn('takeSkillHandoff', [
    [[], 'docs', 1],
    [[step('queueSkillHandoff', 1, SH('s', 'docs'))], 'docs', 1],
    [[step('queueSkillHandoff', 1, SH('s', 'docs'))], 'sheets', 1],
    [[step('queueSkillHandoff', 1, SH('s', 'docs'))], 'docs', 2],
    [
      [step('queueSkillHandoff', 1, SH('s', 'docs')), step('takeSkillHandoff', 'docs', 1)],
      'docs',
      1,
    ],
    [
      [step('queueSkillHandoff', 1, SH('s', 'sheets', { preview: PREVIEW, attach: ['/a', '/b'] }))],
      'sheets',
      1,
    ],
    [[step('queueGenerateHandoff', 1, GH('g', 'slides'))], 'slides', 1],
    [[step('queueSkillHandoff', 1, SH('s', 'slides'))], 'slides', 1],
    [[step('queueSkillHandoff', 1, SH('s', 'docs'))], 'constructor', 1],
    [[step('queueSkillHandoff', 1, SH('s', 'docs')), step('dropGenerateHandoff', 1)], 'docs', 1],
  ]),
  'generate-handoff.queuedSkillHandoffs': handoffFn('queuedSkillHandoffs', [
    [[]],
    [[step('queueSkillHandoff', 2, SH('b', 'pdf')), step('queueSkillHandoff', 1, SH('a', 'docs'))]],
    [
      [
        step('queueSkillHandoff', 2, SH('b', 'pdf')),
        step('queueSkillHandoff', 1, SH('a', 'docs')),
        step('queueSkillHandoff', 2, SH('b2', 'epub')),
      ],
    ],
    [
      [
        step('queueSkillHandoff', 2, SH('b', 'pdf')),
        step('queueSkillHandoff', 1, SH('a', 'docs')),
        step('takeSkillHandoff', 'pdf', 2),
      ],
    ],
  ]),
  'generate-handoff.queuedGenerateHandoffs': handoffFn('queuedGenerateHandoffs', [
    [[]],
    [
      [
        step('queueGenerateHandoff', 2, GH('b', 'html')),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
      ],
    ],
    [
      [
        step('queueGenerateHandoff', 2, GH('b', 'html')),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('queueGenerateHandoff', 2, GH('b2', 'mindmap')),
      ],
    ],
    [
      [
        step('queueGenerateHandoff', 2, GH('b', 'html')),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'html', 2),
      ],
    ],
    [
      [
        step('queueGenerateHandoff', 2, GH('b', 'html')),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('dropGenerateHandoff', 2),
        step('queueGenerateHandoff', 2, GH('c', 'html')),
      ],
    ],
  ]),
  'generate-handoff.setGenerateTabIdResolver': handoffFn('setGenerateTabIdResolver', [
    [[], null],
    [[], { table: { '1': 'tab-1' } }],
    [[step('setGenerateTabIdResolver', { table: { '1': 'x' } })], null],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      { table: { '1': 'tab-1' } },
    ],
    [
      [
        step('setGenerateTabIdResolver', { table: { '1': 'tab-1' } }),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('reportGenerateRunStarted', 'slides', 1, ['/m/a.docx']),
      ],
      null,
    ],
  ]),
  'generate-handoff.reportGenerateRunStarted': handoffFn('reportGenerateRunStarted', [
    [[], 'slides', 1, ['/m/a.docx']],
    [[step('queueGenerateHandoff', 1, GH('a', 'slides'))], 'slides', 1, ['/m/a.docx']],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'html',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      2,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      [],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/other.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/b.pdf', '/m/a.docx', '/m/zzz'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/./a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/x/../a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m//a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx/'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/M/A.DOCX'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      [5, null, '/m/a.docx', { path: '/m/b.pdf' }],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', ['/m/A.DOCX', '/m/b.pdf'])),
        step('takeGenerateHandoff', 'slides', 1),
        step('setPlatform', 'win32'),
      ],
      'slides',
      1,
      ['/M/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', ['/m/A.DOCX', '/m/b.pdf'])),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/M/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', ['/m/\u0130.txt', '/m/\u03A3.txt'])),
        step('takeGenerateHandoff', 'slides', 1),
        step('setPlatform', 'win32'),
      ],
      'slides',
      1,
      ['/m/i\u0307.txt', '/m/\u03C3.txt'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', ['rel/a.docx'])),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['rel/./a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', ['rel/a.docx'])),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      [''],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', [''])),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['.'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', [])),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', ['/m/a.docx', '/m/a.docx'])),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('setGenerateTabIdResolver', { table: { '1': 'tab-1' } }),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('setGenerateTabIdResolver', { table: { '1': '' } }),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('setGenerateTabIdResolver', { table: { '2': 'other' } }),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('setGenerateTabIdResolver', { table: {}, throwsFor: [1] }),
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('reportGenerateRunStarted', 'slides', 1, ['/m/a.docx']),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('queueGenerateHandoff', 1, GH('b', 'slides')),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('dropGenerateHandoff', 1),
      ],
      'slides',
      1,
      ['/m/a.docx'],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides', ['/p/x'])),
        step('takeGenerateHandoff', 'slides', 1),
        step('queueGenerateHandoff', 2, GH('b', 'slides', ['/p/y'])),
        step('takeGenerateHandoff', 'slides', 2),
        step('reportGenerateRunStarted', 'slides', 2, ['/p/y']),
      ],
      'slides',
      1,
      ['/p/x'],
    ],
    [manyRuns(201), 'slides', 201, []],
    [
      [
        ...manyRuns(201),
        step('queueGenerateHandoff', 500, GH('last', 'slides', ['/p/last'])),
        step('takeGenerateHandoff', 'slides', 500),
      ],
      'slides',
      500,
      ['/p/last'],
    ],
  ]),
  'generate-handoff.generateRunStartedEvents': handoffFn('generateRunStartedEvents', [
    [[]],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('reportGenerateRunStarted', 'slides', 1, ['/m/a.docx']),
      ],
    ],
    [manyRuns(3)],
    [manyRuns(200)],
    [manyRuns(203)],
  ]),
  'generate-handoff.recordGenerateConverted': handoffFn('recordGenerateConverted', [
    [[], CONVERT(1, ['/c/a.xmind'])],
    [[], CONVERT(1, [])],
    [[], CONVERT(1, ['/c/a.xmind', '', '/c/b.xmind'])],
    [[], CONVERT(1, ['/c/a', 5, null, '/c/b'])],
    [[], CONVERT(2, ['/c/a'], { target: 'slides', kind: 'mindmap-to-slides' })],
    [[], CONVERT(3, ['/c/a.md'], { target: 'mindmap', kind: 'markdown-to-mindmap' })],
    [[step('setGenerateTabIdResolver', { table: { '1': 'tab-1' } })], CONVERT(1, ['/c/a'])],
    [[step('setGenerateTabIdResolver', { table: { '1': 'tab-1' } })], CONVERT(2, ['/c/a'])],
    [[step('setGenerateTabIdResolver', { table: { '1': '' } })], CONVERT(1, ['/c/a'])],
    [[step('setGenerateTabIdResolver', { table: {}, throwsFor: [1] })], CONVERT(1, ['/c/a'])],
    [[step('recordGenerateConverted', CONVERT(1, ['/c/first']))], CONVERT(1, ['/c/second'])],
    [manyConverted(201), CONVERT(900, ['/c/last'])],
    [manyConverted(10), CONVERT(900, ['/c/unicode-\u00e9\u{1F600}'])],
  ]),
  'generate-handoff.generateConvertedEvents': handoffFn('generateConvertedEvents', [
    [[]],
    [[step('recordGenerateConverted', CONVERT(1, ['/c/a']))]],
    [manyConverted(3)],
    [manyConverted(200)],
    [manyConverted(205)],
  ]),
  'generate-handoff.resetGenerateHandoffsForTest': handoffFn('resetGenerateHandoffsForTest', [
    [[]],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('queueSkillHandoff', 2, SH('s', 'docs')),
        step('setGenerateTabIdResolver', { table: { '1': 'tab-1' } }),
        step('recordGenerateConverted', CONVERT(1, ['/c/a'])),
      ],
    ],
    [
      [
        step('queueGenerateHandoff', 1, GH('a', 'slides')),
        step('takeGenerateHandoff', 'slides', 1),
        step('reportGenerateRunStarted', 'slides', 1, ['/m/a.docx']),
        step('queueGenerateHandoff', 3, GH('c', 'html')),
      ],
    ],
  ]),
}
