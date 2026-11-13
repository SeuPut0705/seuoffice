/**
 * Part `cloud` of group `b3-projects`: apps/shell/src/main/projects/
 * cloud-files.ts and cloud-cache.ts. The Rust side is
 * crates/main-core/src/calls/b3_projects/cloud.rs.
 *
 * The attribute reader a case names is built the same way on both sides:
 * - `{ listings, fail? }` is a reader of the caller; each call is the log line
 *   `read dirs timeoutMs`, then it rejects with `fail` or answers the listings
 *   (`[dir, entries | null]`, entries as `[name, attributes]`);
 * - `{ run: { out? , fail? }, env? }` is `createPowerShellAttributeReader` over
 *   a fake program runner; each run is the log line
 *   `run file args { cwd, timeoutMs, input, env }`, then it rejects with `fail`
 *   or answers `out`.
 * A case without a reader never reaches one (not Windows, or no directory).
 * Maps answer as `[...map]`, a Map of Maps as pairs of pairs.
 *
 * `os.homedir()` is read by the TypeScript itself; the Rust gets it as
 * `osHome` of the options, which is the same value on the machine that runs
 * the comparison.
 *
 * The cache scenario (`createCachedCloudResolver`) runs a list of operations
 * over one cache: each has the paths to resolve, the clock the call reads
 * (`now`: a number, or a list taken one per read, the last repeated), and the
 * answer of the detector for that call (`answers`, or `fail`).
 */
import { homedir } from 'node:os'
import {
  CLOUD_ONLY_ATTRIBUTES,
  DEFAULT_LISTING_TIMEOUT_MS,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  FILE_ATTRIBUTE_RECALL_ON_OPEN,
  POWERSHELL_LISTING_SCRIPT,
  createPowerShellAttributeReader,
  detectCloudOnlyFiles,
  isCloudOnlyAttributes,
  isOnGoogleDriveStream,
  isUnderKnownSyncFolder,
  knownSyncFolders,
  parseAttributeListing,
  resolveCloudOnly,
} from '../../../apps/shell/src/main/projects/cloud-files.ts'
import type { AttributeReader } from '../../../apps/shell/src/main/projects/cloud-files.ts'
import {
  CONTEXT_CLOUD_CACHE_MS,
  createCachedCloudResolver,
} from '../../../apps/shell/src/main/projects/cloud-cache.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    single: 'a constant',
    cases: [
      { args: [] },
      { args: [], files: { 'x.txt': 'x' }, note: 'the folder after the call differs' },
    ],
  }
}

const OFFLINE = 0x1000
const RECALL_OPEN = 0x40000
const RECALL_DATA = 0x400000
const ARCHIVE = 0x20
const DIRECTORY = 0x10
const HOME = homedir()

type Env = Record<string, string>
type Listing = [string, [string, number][] | null][]

interface RunCfg {
  out?: string
  fail?: string
}

interface ReaderCfg {
  listings?: Listing
  fail?: string
  run?: RunCfg
  env?: Env
}

function pairs(map: ReadonlyMap<string, unknown>): unknown {
  return [...map]
}

function listingPairs(map: ReadonlyMap<string, ReadonlyMap<string, number> | null>): unknown {
  return [...map].map(([dir, entries]) => [dir, entries === null ? null : [...entries]])
}

function makeReader(cfg: ReaderCfg | undefined, cx: TsContext): AttributeReader | undefined {
  if (cfg === undefined) return undefined
  if (cfg.run !== undefined) {
    const run = cfg.run
    return createPowerShellAttributeReader({
      env: cfg.env ?? {},
      run: async (file, args, options) => {
        cx.log('run', file, [...args], {
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          input: options.input,
          env: options.env,
        })
        if (run.fail !== undefined) throw new Error(run.fail)
        return run.out ?? ''
      },
    })
  }
  return async (dirs, { timeoutMs }) => {
    cx.log('read', [...dirs], timeoutMs)
    if (cfg.fail !== undefined) throw new Error(cfg.fail)
    return new Map(
      (cfg.listings ?? []).map(([dir, entries]) => [
        dir,
        entries === null ? null : new Map(entries),
      ]),
    )
  }
}

interface SyncCfg {
  platform: string
  homeDir?: string
  extraRoots?: string[]
  /** `os.homedir()`: only Rust reads it */
  osHome: string
}

function syncOptions(cfg: SyncCfg): {
  platform: NodeJS.Platform
  homeDir?: string
  extraRoots?: string[]
} {
  return {
    platform: cfg.platform as NodeJS.Platform,
    ...(cfg.homeDir === undefined ? {} : { homeDir: cfg.homeDir }),
    ...(cfg.extraRoots === undefined ? {} : { extraRoots: cfg.extraRoots }),
  }
}

// ---------------------------------------------------------------------------
// isCloudOnlyAttributes
// ---------------------------------------------------------------------------

const ATTRIBUTE_CASES: number[] = [
  0,
  OFFLINE,
  RECALL_OPEN,
  RECALL_DATA,
  ARCHIVE,
  DIRECTORY,
  ARCHIVE | RECALL_DATA,
  0x2000,
  0x80000,
  0x800000,
  0xfff,
  0x7fffffff,
  0x80000000 + OFFLINE,
  0x100000000 + OFFLINE,
  0x100000000,
  2 ** 53 - 1,
  2 ** 53,
  1e21,
  1e300,
  -1,
  -OFFLINE,
  1.5,
  OFFLINE + 0.5,
  0.1,
]

// ---------------------------------------------------------------------------
// parseAttributeListing
// ---------------------------------------------------------------------------

const D0 = 'C:\\Docs'
const D1 = 'D:\\Other folder'
const D2 = '\\\\srv\\share\\dir'

const LISTING_CASES: [string, string[]][] = [
  ['END\n', []],
  ['END', []],
  ['END\n', [D0]],
  ['D\t0\nEND\n', [D0]],
  ['D\t0\nF\t32\ta.txt\nF\t4096\tb.txt\nEND\n', [D0]],
  ['D\t0\r\nF\t32\ta.txt\r\nEND\r\n', [D0]],
  ['\n\nD\t0\n\nF\t32\ta.txt\n\nEND\n\n', [D0]],
  ['D\t0\nF\t32\ta.txt\nE\t1\nD\t2\nF\t4194304\tc d.txt\nEND\n', [D0, D1, D2]],
  ['D\t0\nF\t32\ta.txt\nD\t1\nF\t262144\tb\u00e9.txt\nEND\n', [D0, D1]],
  ['D\t1\nF\t4096\t\u{1F600}.txt\nEND\n', [D0, D1]],
  ['E\t0\nEND\n', [D0]],
  ['D\t0\nF\t32\ta.txt\nE\t0\nEND\n', [D0]],
  ['D\t0\nF\t32\ta.txt\nD\t0\nF\t16\tb.txt\nEND\n', [D0]],
  ['D\t0\nF\t32\ta.txt\nF\t4096\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t32\tb.txt\nF\t32\ta.txt\nF\t4096\tb.txt\nEND\n', [D0]],
  ['D\t0\nF\t1\tx\nD\t1\nF\t2\ty\nEND\n', [D0, D0]],
  ['D\t0\nF\t32\ta.txt\nEND\n', [D0, D1]],
  ['D\t01\nF\t32\ta.txt\nEND\n', [D0, D1]],
  ['D\t0\textra\nF\t32\ta.txt\nEND\textra\n', [D0]],
  ['D\t0\nF\t007\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t9007199254740991\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t32\t\nEND\n', [D0]],
  ['D\t0\nF\t32\t a b \nEND\n', [D0]],
  ['D\t0\nF\t32\tD\t0\nEND\n', [D0]],
  // errors
  ['', [D0]],
  ['\n\n', [D0]],
  ['D\t0\nF\t32\ta.txt\n', [D0]],
  ['END\nEND\n', [D0]],
  ['END\nD\t0\n', [D0]],
  ['D\t0\nEND\nF\t1\tx\n', [D0]],
  ['D\t1\nEND\n', [D0]],
  ['D\t-1\nEND\n', [D0]],
  ['D\tx\nEND\n', [D0]],
  ['D\t\nEND\n', [D0]],
  ['D\nEND\n', [D0]],
  ['D\t1.5\nEND\n', [D0, D1]],
  ['D\t 0\nEND\n', [D0]],
  ['D\t99999999999999999999\nEND\n', [D0]],
  ['D\t\u0663\nEND\n', [D0]],
  ['E\t5\nEND\n', [D0]],
  ['E\nEND\n', [D0]],
  ['F\t32\ta.txt\nEND\n', [D0]],
  ['E\t0\nF\t32\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t32\nEND\n', [D0]],
  ['D\t0\nF\nEND\n', [D0]],
  ['D\t0\nF\t32\ta\tb.txt\nEND\n', [D0]],
  ['D\t0\nF\tx\ta.txt\nEND\n', [D0]],
  ['D\t0\nE\t1\nF\t32\tb.txt\nEND\n', [D0, D1]],
  ['D\t0\nF\t\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t-32\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t3.5\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t1e3\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t0x20\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t9007199254740992\ta.txt\nEND\n', [D0]],
  ['D\t0\nF\t\u0663\ta.txt\nEND\n', [D0]],
  ['X\t0\nEND\n', [D0]],
  ['d\t0\nEND\n', [D0]],
  ['end\n', [D0]],
  ['END\r', [D0]],
  ['\ufeffD\t0\nEND\n', [D0]],
  ['D\t0\nhello\nEND\n', [D0]],
  ['D\t0\n F\t1\tx\nEND\n', [D0]],
  ['D\t0\nF\t32\ta.txt\rEND\n', [D0]],
]

// ---------------------------------------------------------------------------
// createPowerShellAttributeReader
// ---------------------------------------------------------------------------

const OK_RUN: RunCfg = { out: 'D\t0\nF\t4096\ta.txt\nE\t1\nEND\n' }

function readerCase(
  cfg: { env?: Env; run: RunCfg },
  dirs: string[],
  timeoutMs: number,
  note?: string,
): Case {
  return { args: [cfg, dirs, timeoutMs], ...(note === undefined ? {} : { note }) }
}

const READER_CASES: Case[] = [
  readerCase({ run: OK_RUN }, [D0, D1], 20000),
  readerCase({ run: OK_RUN }, [D0, D1], 5),
  readerCase({ env: { SystemRoot: 'D:\\WinNT' }, run: OK_RUN }, [D0, D1], 1000, 'SystemRoot'),
  readerCase({ env: { SYSTEMROOT: 'E:\\Win' }, run: OK_RUN }, [D0, D1], 1000, 'SYSTEMROOT'),
  readerCase({ env: { windir: 'F:\\Windows' }, run: OK_RUN }, [D0, D1], 1000, 'windir'),
  readerCase(
    { env: { SystemRoot: 'D:\\A', SYSTEMROOT: 'E:\\B', windir: 'F:\\C' }, run: OK_RUN },
    [D0, D1],
    1000,
    'the first of the three that is valid',
  ),
  readerCase(
    { env: { SystemRoot: 'relative\\dir', SYSTEMROOT: 'E:\\B', windir: 'F:\\C' }, run: OK_RUN },
    [D0, D1],
    1000,
    'a relative SystemRoot is passed over',
  ),
  readerCase(
    { env: { SystemRoot: 'C:\\Win%dir%' }, run: OK_RUN },
    [D0, D1],
    1000,
    'a percent sign',
  ),
  readerCase({ env: { SystemRoot: 'C:\\Win\r\nX' }, run: OK_RUN }, [D0, D1], 1000, 'a line break'),
  readerCase({ env: { SystemRoot: 'C:\\' }, run: OK_RUN }, [D0, D1], 1000, 'a bare drive root'),
  readerCase({ env: { SystemRoot: 'C:' }, run: OK_RUN }, [D0, D1], 1000, 'a drive only'),
  readerCase(
    { env: { SystemRoot: 'C:\\Windows\\' }, run: OK_RUN },
    [D0, D1],
    1000,
    'a trailing separator',
  ),
  readerCase(
    { env: { SystemRoot: 'D:\\Win\\' }, run: OK_RUN },
    [D0, D1],
    1000,
    'a trailing separator on another drive',
  ),
  readerCase(
    { env: { SystemRoot: 'C:\\Win\\\\dows' }, run: OK_RUN },
    [D0, D1],
    1000,
    'an empty segment',
  ),
  readerCase({ env: { SystemRoot: 'C:\\a\\..\\b' }, run: OK_RUN }, [D0, D1], 1000, 'dot segments'),
  readerCase({ env: { SystemRoot: 'C:\\Win dows\\\u00fcn\u00ef' }, run: OK_RUN }, [D0, D1], 1000),
  readerCase({ env: { SystemRoot: 'C:/Windows' }, run: OK_RUN }, [D0, D1], 1000, 'forward slash'),
  readerCase({ env: { SystemRoot: '' }, run: OK_RUN }, [D0, D1], 1000, 'empty'),
  readerCase({ env: { Path: 'C:\\x', windir: 'C:\\Windows' }, run: OK_RUN }, [D0], 1000),
  readerCase({ run: { fail: 'spawn ENOENT' } }, [D0], 1000, 'the program fails'),
  readerCase({ run: { fail: 'timed out' } }, [D0, D1, D2], 3, 'the program times out'),
  readerCase({ run: { out: '' } }, [D0], 1000, 'no output'),
  readerCase({ run: { out: 'D\t0\nF\t4096\ta.txt\n' } }, [D0], 1000, 'unfinished'),
  readerCase({ run: { out: 'D\t3\nEND\n' } }, [D0], 1000, 'a directory that was not asked'),
  readerCase({ run: { out: 'END\n' } }, [], 1000, 'no directory'),
  readerCase(
    { run: OK_RUN },
    ['C:\\\u00fcn\u00ef\\\u{1F600}', D1],
    1000,
    'a path of any characters',
  ),
]

// ---------------------------------------------------------------------------
// detectCloudOnlyFiles
// ---------------------------------------------------------------------------

interface DetectCfg {
  platform: string
  timeoutMs?: number
  reader?: ReaderCfg
}

function detectCase(paths: string[], cfg: DetectCfg, note?: string): Case {
  return { args: [paths, cfg], ...(note === undefined ? {} : { note }) }
}

const LISTED: Listing = [
  [
    'C:\\Docs',
    [
      ['cloud.txt', OFFLINE],
      ['local.txt', ARCHIVE],
    ],
  ],
  ['C:\\Other', null],
]

const ATTRIBUTE_LISTING: Listing = [
  [
    'C:\\A',
    [
      ['offline', OFFLINE],
      ['open', RECALL_OPEN],
      ['data', RECALL_DATA],
      ['archive', ARCHIVE],
      ['directory', DIRECTORY],
      ['zero', 0],
      ['all', RECALL_DATA | OFFLINE | ARCHIVE],
      ['wrapped', 0x100000000 + OFFLINE],
      ['near', 0x2000],
    ],
  ],
]

const ATTRIBUTE_PATHS = [
  'offline',
  'open',
  'data',
  'archive',
  'directory',
  'zero',
  'all',
  'wrapped',
  'near',
  'none',
].map((name) => `C:\\A\\${name}`)

const WIN: DetectCfg = { platform: 'win32', reader: { listings: LISTED } }

const DETECT_CASES: Case[] = [
  detectCase([], WIN, 'no path'),
  detectCase(
    ['/Users/a/x.txt', 'C:\\Docs\\cloud.txt'],
    { platform: 'darwin', reader: { listings: LISTED } },
    'not Windows',
  ),
  detectCase(['/home/a/x.txt'], { platform: 'linux', reader: { listings: LISTED } }),
  detectCase(
    ['C:\\Docs\\cloud.txt'],
    { platform: 'linux' },
    'no reader is built where it is not needed',
  ),
  detectCase(
    [
      'Docs\\a.txt',
      '\\Docs\\a.txt',
      'C:a.txt',
      'a.txt',
      '',
      '\\\\srv',
      '\\\\srv\\',
      '\\\\\\x\\y',
      '/Docs/a.txt',
    ],
    WIN,
    'no absolute path: the reader is not asked',
  ),
  detectCase(
    ['C:\\Docs\\a\nb.txt', 'C:\\Docs\\a\rb.txt', 'C:\\Do\ncs\\a.txt'],
    WIN,
    'a line break',
  ),
  detectCase(
    ['C:\\', 'C:\\\\', 'C:/', '\\\\srv\\share', '\\\\srv\\share\\'],
    WIN,
    'paths without a name',
  ),
  detectCase(
    [
      'C:\\Docs\\cloud.txt',
      'C:\\Docs\\local.txt',
      'C:\\Docs\\absent.txt',
      'C:\\Other\\x.txt',
      'D:\\Third\\y.txt',
    ],
    WIN,
    'one of each verdict',
  ),
  detectCase(
    ATTRIBUTE_PATHS,
    { platform: 'win32', reader: { listings: ATTRIBUTE_LISTING } },
    'each attribute word',
  ),
  detectCase(
    ['C:\\Docs\\cloud.txt', 'c:\\docs\\LOCAL.TXT', 'C:/DOCS/cloud.txt', 'C:\\Docs\\\\local.txt'],
    WIN,
    'a folder spelled in several ways is listed once',
  ),
  detectCase(
    [
      'C:\\Docs\\sub\\..\\cloud.txt',
      'C:\\Docs\\.\\local.txt',
      'C:\\Docs\\cloud.txt\\',
      'C:\\Docs\\x\\..\\..\\Docs\\local.txt',
    ],
    WIN,
    'paths that are normalized',
  ),
  detectCase(
    [
      'C:\\D\\Readme.txt',
      'C:\\D\\readme.TXT',
      'C:\\D\\README.txt',
      'C:\\D\\a.Txt',
      'C:\\D\\A.txt',
      'C:\\D\\a.txt',
      'C:\\D\\b.TXT',
    ],
    {
      platform: 'win32',
      reader: {
        listings: [
          [
            'C:\\D',
            [
              ['Readme.TXT', OFFLINE],
              ['A.txt', OFFLINE],
              ['a.TXT', ARCHIVE],
              ['B.txt', ARCHIVE],
            ],
          ],
        ],
      },
    },
    'a name found by its exact spelling, then by its only case-folded match',
  ),
  detectCase(
    [
      'C:\\D\\\u00c9t\u00e9.txt',
      'C:\\D\\\u00e9T\u00c9.txt',
      'C:\\D\\\u0130.txt',
      'C:\\D\\i\u0307.txt',
      'C:\\D\\\u00df.txt',
      'C:\\D\\SS.txt',
    ],
    {
      platform: 'win32',
      reader: {
        listings: [
          [
            'C:\\D',
            [
              ['\u00e9t\u00c9.txt', OFFLINE],
              ['i\u0307.txt', OFFLINE],
              ['\u00df.txt', ARCHIVE],
            ],
          ],
        ],
      },
    },
    'case folding outside ASCII',
  ),
  detectCase(
    [
      '\\\\srv\\share\\dir\\f.txt',
      '//srv/share/dir/g.txt',
      '\\\\srv\\share\\h.txt',
      '\\\\SRV\\Share\\dir\\i.txt',
    ],
    {
      platform: 'win32',
      reader: {
        listings: [
          [
            '\\\\srv\\share\\dir',
            [
              ['f.txt', OFFLINE],
              ['g.txt', ARCHIVE],
              ['i.txt', ARCHIVE],
            ],
          ],
          ['\\\\srv\\share\\', [['h.txt', OFFLINE]]],
        ],
      },
    },
    'UNC paths',
  ),
  detectCase(
    ['C:\\Docs\\cloud.txt', 'C:\\Docs\\cloud.txt', 'C:\\Docs\\local.txt', 'C:\\Docs\\cloud.txt'],
    WIN,
    'a path listed twice',
  ),
  detectCase(
    ['C:\\Docs\\cloud.txt', 'relative.txt', 'C:\\Docs\\local.txt'],
    WIN,
    'the order of the answer',
  ),
  detectCase(
    ['C:\\Docs\\cloud.txt', 'D:\\More\\a.txt'],
    { platform: 'win32', reader: { listings: LISTED, fail: 'boom' } },
    'the listing fails as a whole',
  ),
  detectCase(
    ['C:\\Docs\\cloud.txt'],
    { platform: 'win32', timeoutMs: 5000, reader: { listings: LISTED } },
    'the timeout is handed on',
  ),
  detectCase(
    ['C:\\Docs\\cloud.txt'],
    { platform: 'win32', timeoutMs: 0, reader: { listings: LISTED } },
    'a timeout of 0 is kept',
  ),
  detectCase(
    ['C:\\Docs\\cloud.txt', 'C:\\Docs\\local.txt', 'C:\\Docs\\absent.txt'],
    {
      platform: 'win32',
      reader: { run: { out: 'D\t0\nF\t4096\tcloud.txt\nF\t32\tlocal.txt\nEND\n' } },
    },
    'through the PowerShell reader',
  ),
  detectCase(
    ['C:\\Docs\\a.txt', 'D:\\More\\b.txt'],
    {
      platform: 'win32',
      timeoutMs: 7,
      reader: { run: { out: 'D\t0\nF\t4096\ta.txt\nE\t1\nEND\n' }, env: { windir: 'E:\\Win' } },
    },
    'through the PowerShell reader, a folder that cannot be listed',
  ),
  detectCase(
    ['C:\\Docs\\a.txt'],
    { platform: 'win32', reader: { run: { fail: 'timed out' } } },
    'the program fails',
  ),
  detectCase(
    ['C:\\Docs\\a.txt'],
    { platform: 'win32', reader: { run: { out: 'D\t0\nF\t4096\ta.txt\n' } } },
    'the output is incomplete',
  ),
  detectCase(
    ['C:\\Docs\\a.txt'],
    { platform: 'win32', reader: { listings: [['C:\\Docs', []]] } },
    'an empty folder',
  ),
  detectCase(
    ['C:\\Docs\\a.txt'],
    { platform: 'win32', reader: { listings: [['c:\\docs', [['a.txt', OFFLINE]]]] } },
    'a listing under another spelling of the folder is not found',
  ),
]

// ---------------------------------------------------------------------------
// knownSyncFolders, isUnderKnownSyncFolder, isOnGoogleDriveStream
// ---------------------------------------------------------------------------

const ONEDRIVE = 'C:\\Users\\me\\OneDrive'
const HOME_WIN = 'C:\\Users\\me'

const ENVS: Env[] = [
  {},
  { OneDrive: ONEDRIVE },
  {
    OneDrive: ONEDRIVE,
    OneDriveConsumer: 'C:\\Users\\me\\OneDrive - Personal',
    OneDriveCommercial: 'C:\\Users\\me\\OneDrive - Corp',
  },
  { OneDrive: '', OneDriveConsumer: ONEDRIVE },
  { OneDrive: 'relative\\OneDrive', OneDriveCommercial: ONEDRIVE },
  {
    OneDrive: ONEDRIVE,
    OneDriveConsumer: 'c:\\users\\me\\ONEDRIVE\\',
    OneDriveCommercial: 'C:/Users/me/OneDrive',
  },
  {
    OneDrive: '/home/me/OneDrive',
    OneDriveConsumer: '/home/me/onedrive',
    OneDriveCommercial: '/home/me/OneDrive/',
  },
  { OneDrive: '/Users/me/OneDrive', OneDriveConsumer: '/users/me/onedrive' },
  { USERPROFILE: 'D:\\Profiles\\you', HOME: '/home/you' },
  { USERPROFILE: 'relative', HOME: 'relative' },
  { USERPROFILE: '', HOME: '' },
  { HOME: '/Users/me' },
  { USERPROFILE: HOME_WIN, OneDrive: ONEDRIVE },
]

const SYNC_CFGS: SyncCfg[] = [
  { platform: 'win32', osHome: HOME },
  { platform: 'win32', homeDir: HOME_WIN, osHome: HOME },
  {
    platform: 'win32',
    homeDir: 'C:\\Users\\me\\',
    extraRoots: ['E:\\Shared', 'e:\\shared\\', 'relative', 'F:/Team/Drive'],
    osHome: HOME,
  },
  { platform: 'win32', homeDir: 'relative', osHome: HOME },
  { platform: 'win32', homeDir: '', extraRoots: ['Z:\\Z'], osHome: HOME },
  { platform: 'win32', homeDir: '\\\\srv\\share\\me', osHome: HOME },
  { platform: 'darwin', homeDir: '/Users/me', osHome: HOME },
  {
    platform: 'darwin',
    extraRoots: ['/Volumes/Team', '/volumes/team/', '/Users/me/Dropbox'],
    osHome: HOME,
  },
  {
    platform: 'linux',
    homeDir: '/home/me',
    extraRoots: ['/mnt/drive', '/mnt/Drive', '/mnt/drive//'],
    osHome: HOME,
  },
  { platform: 'linux', osHome: HOME },
  { platform: 'freebsd', extraRoots: ['/data/sync'], osHome: HOME },
]

const KNOWN_CASES: Case[] = ENVS.flatMap((env) =>
  SYNC_CFGS.map((cfg): Case => ({ args: [env, cfg] })),
)

const WIN_PATHS = [
  'C:\\Users\\me\\OneDrive\\a.docx',
  'c:\\users\\me\\onedrive\\Sub\\b.docx',
  'C:\\Users\\me\\OneDrive',
  'C:\\Users\\me\\OneDrive\\',
  'C:\\Users\\me\\OneDriveX\\a.docx',
  'C:\\Users\\me\\OneDrive - Personal\\a.docx',
  'C:/Users/me/OneDrive/a.docx',
  'C:\\Users\\me\\OneDrive\\..\\Docs\\a.docx',
  'C:\\Users\\me\\My Drive\\a.docx',
  'C:\\Users\\me\\Google Drive\\a.docx',
  'C:\\Users\\me\\google drive\\a.docx',
  'C:\\Users\\me\\Docs\\a.docx',
  'E:\\Shared\\a.docx',
  'F:\\Team\\Drive\\a.docx',
  'G:\\My Drive\\a.docx',
  'G:\\\ub0b4 \ub4dc\ub77c\uc774\ube0c\\a.docx',
  '\\\\srv\\share\\me\\My Drive\\a.docx',
  'relative\\a.docx',
  '\\Users\\me\\OneDrive\\a.docx',
  '/Users/me/OneDrive/a.docx',
]

const POSIX_PATHS = [
  '/Users/me/OneDrive/a.docx',
  '/users/me/onedrive/a.docx',
  '/Users/me/OneDrive',
  '/Users/me/OneDrive/',
  '/Users/me/OneDriveX/a.docx',
  '/home/me/OneDrive/a.docx',
  '/home/me/onedrive/a.docx',
  '/home/me/OneDrive/../b.docx',
  '/mnt/drive/a.docx',
  '/mnt/Drive/a.docx',
  '/Volumes/Team/a.docx',
  '/volumes/team/a.docx',
  '/Volumes/GoogleDrive/My Drive/a.docx',
  '/Volumes/GoogleDrive',
  '/Volumes/GoogleDrive-1234/My Drive/a.docx',
  '/Volumes/GoogleDrive-/a.docx',
  '/Volumes/GoogleDriveX/a.docx',
  '/volumes/googledrive/x',
  '/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/a.docx',
  '/Users/me/Library/CloudStorage/OneDrive-Personal/a.docx',
  '/Users/me/Library/CloudStorage/onedrive-corp/x/a.docx',
  '/Users/me/Library/CloudStorage/Dropbox/a.docx',
  '/Users/me/Library/CloudStorage/',
  '/Users/me/Library/CloudStorage',
  '/Users/me/Library/CloudStorage/GoogleDrive',
  '/Users/ME/library/cloudstorage/googledrive-x/a',
  '/Users/me/Library/Application Support/a.docx',
  '/Users/me/Dropbox/a.docx',
  `${HOME}/Library/CloudStorage/OneDrive-X/a.docx`,
  `${HOME}/Library/CloudStorage/GoogleDrive-X/a.docx`,
  '/data/sync/a.docx',
  '/data/sync',
  '/tmp/a.docx',
  'relative/a.docx',
  'C:\\Users\\me\\OneDrive\\a.docx',
  '',
]

const UNDER_CASES: Case[] = [
  ...WIN_PATHS.flatMap((path) =>
    [
      [ENVS[1], SYNC_CFGS[1]],
      [ENVS[12], SYNC_CFGS[2]],
      [ENVS[5], SYNC_CFGS[3]],
    ].map(([env, cfg]): Case => ({ args: [path, env, cfg] })),
  ),
  ...POSIX_PATHS.flatMap((path) =>
    [
      [ENVS[6], SYNC_CFGS[8]],
      [ENVS[7], SYNC_CFGS[6]],
      [ENVS[11], SYNC_CFGS[7]],
      [ENVS[0], SYNC_CFGS[9]],
      [ENVS[11], SYNC_CFGS[9]],
    ].map(([env, cfg]): Case => ({ args: [path, env, cfg] })),
  ),
  {
    args: [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      { HOME: '/Users/me' },
      { platform: 'darwin', osHome: HOME },
    ],
    note: 'the home folder from HOME',
  },
  {
    args: [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      { HOME: 'relative' },
      { platform: 'darwin', osHome: HOME },
    ],
    note: 'HOME is not absolute',
  },
  {
    args: [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      { HOME: '' },
      { platform: 'darwin', osHome: '/Users/me' },
    ],
    note: 'the OS home folder',
  },
  {
    args: [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      {},
      { platform: 'darwin', homeDir: '/other', osHome: '/Users/me' },
    ],
    note: 'homeDir wins',
  },
  {
    args: [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      {},
      { platform: 'darwin', homeDir: '/Users/me/', osHome: '/x' },
    ],
    note: 'a trailing separator of the home folder',
  },
  {
    args: [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      {},
      { platform: 'darwin', homeDir: '', osHome: '/Users/me' },
    ],
    note: 'an empty homeDir is kept',
  },
  {
    args: [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      {},
      { platform: 'linux', homeDir: '/Users/me', osHome: '/Users/me' },
    ],
    note: 'the rule is macOS only',
  },
  {
    args: ['G:\\My Drive\\a.docx', {}, { platform: 'win32', osHome: HOME }],
    note: 'the streaming drive',
  },
  { args: ['G:\\Shared Drives\\Team\\a.docx', {}, { platform: 'win32', osHome: HOME }] },
  { args: ['G:\\Other\\a.docx', {}, { platform: 'win32', osHome: HOME }] },
  { args: ['G:\\My Drive\\a.docx', {}, { platform: 'linux', osHome: HOME }], note: 'not Windows' },
  { args: ['G:\\My Drive\\a.docx', {}, { platform: 'darwin', osHome: HOME }] },
]

const GOOGLE_CASES: [string, string][] = [
  ['G:\\My Drive\\a.docx', 'win32'],
  ['G:\\My Drive', 'win32'],
  ['G:\\My Drive\\', 'win32'],
  ['g:\\MY DRIVE\\a', 'win32'],
  ['G:/My Drive/a.docx', 'win32'],
  ['G:\\\\My Drive\\a', 'win32'],
  ['G:\\.\\My Drive\\a', 'win32'],
  ['G:\\x\\..\\My Drive\\a', 'win32'],
  ['G:\\My Drive2\\a', 'win32'],
  ['G:\\Shared drives\\Team\\a', 'win32'],
  ['G:\\Shared Drives\\Team\\a', 'win32'],
  ['H:\\Other computers\\PC\\a', 'win32'],
  ['H:\\.shortcut-targets-by-id\\abc\\a', 'win32'],
  ['H:\\\ub0b4 \ub4dc\ub77c\uc774\ube0c\\a', 'win32'],
  ['H:\\\uacf5\uc720 \ub4dc\ub77c\uc774\ube0c\\a', 'win32'],
  ['H:\\\ub2e4\ub978 \ucef4\ud4e8\ud130\\a', 'win32'],
  ['H:\\\ub0b4\ub4dc\ub77c\uc774\ube0c\\a', 'win32'],
  ['G:\\', 'win32'],
  ['G:/', 'win32'],
  ['G:', 'win32'],
  ['G:\\Docs\\My Drive\\a', 'win32'],
  ['\\\\srv\\share\\My Drive\\a', 'win32'],
  ['My Drive\\a', 'win32'],
  ['\\My Drive\\a', 'win32'],
  ['', 'win32'],
  ['G:\\My Drive\\a', 'darwin'],
  ['G:\\My Drive\\a', 'linux'],
  ['/My Drive/a', 'linux'],
  ['/Volumes/GoogleDrive/My Drive', 'darwin'],
]

// ---------------------------------------------------------------------------
// resolveCloudOnly
// ---------------------------------------------------------------------------

interface ResolveCfg extends SyncCfg {
  timeoutMs?: number
  reader?: ReaderCfg
}

function resolveCase(paths: string[], env: Env, cfg: ResolveCfg, note?: string): Case {
  return { args: [paths, env, cfg], ...(note === undefined ? {} : { note }) }
}

const RESOLVE_LISTING: Listing = [
  [
    'C:\\Users\\me\\OneDrive',
    [
      ['cloud.docx', OFFLINE],
      ['local.docx', ARCHIVE],
    ],
  ],
  [
    'C:\\Docs',
    [
      ['plain.docx', ARCHIVE],
      ['online.docx', RECALL_DATA],
    ],
  ],
  [
    'G:\\My Drive',
    [
      ['stream.docx', ARCHIVE],
      ['marked.docx', OFFLINE],
    ],
  ],
  ['D:\\Broken', null],
]

const RESOLVE_WIN: ResolveCfg = {
  platform: 'win32',
  homeDir: HOME_WIN,
  osHome: HOME,
  reader: { listings: RESOLVE_LISTING },
}

const RESOLVE_PATHS = [
  'C:\\Users\\me\\OneDrive\\cloud.docx',
  'C:\\Users\\me\\OneDrive\\local.docx',
  'C:\\Users\\me\\OneDrive\\unlisted.docx',
  'C:\\Docs\\plain.docx',
  'C:\\Docs\\online.docx',
  'G:\\My Drive\\stream.docx',
  'G:\\My Drive\\marked.docx',
  'G:\\My Drive\\unlisted.docx',
  'D:\\Broken\\a.docx',
  'C:\\Users\\me\\Google Drive\\a.docx',
  'relative.docx',
]

const RESOLVE_CASES: Case[] = [
  resolveCase([], { OneDrive: ONEDRIVE }, RESOLVE_WIN, 'no path'),
  resolveCase(
    RESOLVE_PATHS,
    { OneDrive: ONEDRIVE },
    RESOLVE_WIN,
    'attributes decide, the rule fills the rest',
  ),
  resolveCase(RESOLVE_PATHS, {}, RESOLVE_WIN, 'no known sync folder from the environment'),
  resolveCase(
    RESOLVE_PATHS,
    { OneDrive: ONEDRIVE },
    { ...RESOLVE_WIN, reader: { listings: RESOLVE_LISTING, fail: 'timed out' } },
    'the listing fails: the rule decides',
  ),
  resolveCase(
    RESOLVE_PATHS,
    { OneDrive: ONEDRIVE },
    {
      ...RESOLVE_WIN,
      timeoutMs: 123,
      reader: {
        run: { out: 'D\t0\nF\t4096\tcloud.docx\nF\t32\tlocal.docx\nEND\n' },
        env: { OneDrive: ONEDRIVE },
      },
    },
    'through the PowerShell reader',
  ),
  resolveCase(
    RESOLVE_PATHS,
    { OneDrive: ONEDRIVE },
    { ...RESOLVE_WIN, reader: { run: { fail: 'spawn ENOENT' } } },
    'the program fails',
  ),
  resolveCase(
    ['C:\\Users\\me\\OneDrive\\local.docx', 'E:\\Shared\\x.docx'],
    {},
    { ...RESOLVE_WIN, extraRoots: ['E:\\Shared'], reader: { listings: [] } },
    'a path missing from the listing',
  ),
  resolveCase(
    ['G:\\My Drive\\a.docx', 'G:\\Docs\\a.docx'],
    {},
    {
      platform: 'win32',
      homeDir: HOME_WIN,
      osHome: HOME,
      reader: {
        listings: [
          ['G:\\My Drive', [['a.docx', ARCHIVE]]],
          ['G:\\Docs', [['a.docx', ARCHIVE]]],
        ],
      },
    },
    'a local answer on the streaming drive is not trusted',
  ),
  resolveCase(
    [
      '/Users/me/Library/CloudStorage/OneDrive-X/a.docx',
      '/Users/me/a.docx',
      '/Volumes/GoogleDrive/My Drive/a.docx',
    ],
    {},
    { platform: 'darwin', homeDir: '/Users/me', osHome: HOME },
    'macOS: the rule only',
  ),
  resolveCase(
    ['/Users/me/Library/CloudStorage/OneDrive-X/a.docx', '/Users/me/a.docx'],
    { HOME: '/Users/me' },
    { platform: 'darwin', osHome: HOME },
    'macOS: the home folder from the environment',
  ),
  resolveCase(
    ['/home/me/OneDrive/a.docx', '/home/me/a.docx', '/mnt/x/a.docx', '/Volumes/GoogleDrive/a'],
    { OneDrive: '/home/me/OneDrive' },
    { platform: 'linux', extraRoots: ['/mnt/x'], osHome: HOME },
    'Linux: the rule only',
  ),
  resolveCase(
    ['C:\\Users\\me\\OneDrive\\a.docx', 'G:\\My Drive\\a.docx'],
    { OneDrive: ONEDRIVE },
    { platform: 'linux', osHome: HOME },
    'Windows paths on Linux',
  ),
  resolveCase(
    ['C:\\Users\\me\\OneDrive\\a.docx', 'C:\\Users\\me\\OneDrive\\a.docx', 'C:\\Docs\\plain.docx'],
    { OneDrive: ONEDRIVE },
    RESOLVE_WIN,
    'a path twice',
  ),
]

// ---------------------------------------------------------------------------
// createCachedCloudResolver
// ---------------------------------------------------------------------------

interface CacheOp {
  paths: string[]
  now: number | number[]
  answers?: Record<string, boolean>
  fail?: string
}

async function runCache(
  cfg: { ttlMs?: number },
  ops: CacheOp[],
  cx: TsContext,
): Promise<unknown[]> {
  let current: CacheOp = { paths: [], now: 0 }
  let queue: number[] = []
  let last = 0
  const resolve = createCachedCloudResolver(
    async (paths) => {
      cx.log('resolve', [...paths])
      if (current.fail !== undefined) throw new Error(current.fail)
      return new Map(Object.entries(current.answers ?? {}))
    },
    {
      ...(cfg.ttlMs === undefined ? {} : { ttlMs: cfg.ttlMs }),
      now: () => {
        last = queue.shift() ?? last
        return last
      },
    },
  )
  const out: unknown[] = []
  for (const op of ops) {
    current = op
    queue = Array.isArray(op.now) ? [...op.now] : [op.now]
    try {
      out.push({ ok: [...(await resolve(op.paths))] })
    } catch (error) {
      out.push({ error: (error as Error).message })
    }
  }
  return out
}

const A = 'C:\\Users\\me\\OneDrive\\a.docx'
const B = 'C:\\Users\\me\\OneDrive\\b.docx'
const C = 'C:\\Users\\me\\OneDrive\\c.docx'
const BOTH = { [A]: true, [B]: false }

const CACHE_CASES: Case[] = [
  { args: [{}, []], note: 'no operation' },
  { args: [{}, [{ paths: [], now: 1000 }]], note: 'no path: the detector is not asked' },
  {
    args: [
      {},
      [
        { paths: [A, B], now: [1000, 1000], answers: BOTH },
        { paths: [A, B], now: 1000 + 59_999 },
        { paths: [A, B], now: [1000 + 60_000, 1000 + 60_000], answers: { [A]: false, [B]: true } },
        { paths: [A, B], now: 1000 + 60_000 + 59_999 },
      ],
    ],
    note: 'a miss, a hit just inside the time, an expiry exactly at it, a hit again',
  },
  {
    args: [
      { ttlMs: 10 },
      [
        { paths: [A], now: [100, 100], answers: { [A]: true } },
        { paths: [A], now: 109 },
        { paths: [A], now: [110, 110], answers: { [A]: false } },
        { paths: [A], now: 119 },
        { paths: [A], now: 120, answers: { [A]: true } },
      ],
    ],
    note: 'a time of its own',
  },
  {
    args: [
      { ttlMs: 0 },
      [
        { paths: [A], now: [5, 5], answers: { [A]: true } },
        { paths: [A], now: [5, 5], answers: { [A]: false } },
      ],
    ],
    note: 'a time of 0 keeps nothing',
  },
  {
    args: [
      {},
      [
        { paths: [A, B], now: [0, 0], answers: BOTH },
        { paths: [B, C, A], now: [1, 1], answers: { [C]: true } },
      ],
    ],
    note: 'only the unknown paths are asked; known ones answer first',
  },
  {
    args: [
      {},
      [
        { paths: [A, B, C], now: [0, 0], answers: { [B]: true } },
        { paths: [A, B, C], now: [1, 1], answers: { [A]: false, [C]: true } },
      ],
    ],
    note: 'a path the detector leaves out is not remembered',
  },
  {
    args: [
      {},
      [
        { paths: [A], now: [0, 40_000], answers: { [A]: true } },
        { paths: [A], now: 99_999 },
        { paths: [A], now: [100_000, 100_000], answers: { [A]: false } },
      ],
    ],
    note: 'the time of a verdict is when the detector answered',
  },
  {
    args: [
      {},
      [
        { paths: [A], now: [0, 0], answers: { [A]: true } },
        { paths: [B], now: 30_000, fail: 'detector failed' },
        { paths: [A, B], now: [30_001, 30_001], answers: { [B]: false } },
      ],
    ],
    note: 'a failed run is not remembered and does not touch the others',
  },
  {
    args: [
      {},
      [
        { paths: [A], now: [0, 0], answers: { [A]: true } },
        { paths: [A, B], now: 60_000, fail: 'down' },
        { paths: [A], now: [60_001, 60_001], answers: { [A]: false } },
      ],
    ],
    note: 'an entry that expired is gone even when the run after it fails',
  },
  {
    args: [
      {},
      [
        { paths: [A, A, B, B, A], now: [0, 0], answers: BOTH },
        { paths: [A, A, B], now: 1 },
      ],
    ],
    note: 'a path twice in one call',
  },
  {
    args: [
      {},
      [
        { paths: [A], now: [0, 0], answers: { [A]: true } },
        { paths: [B], now: [59_000, 59_000], answers: { [B]: false } },
        { paths: [A, B], now: [61_000, 61_000], answers: { [A]: false } },
        { paths: [A, B], now: 61_001 },
      ],
    ],
    note: 'entries expire one by one',
  },
  {
    args: [
      { ttlMs: 1e9 },
      [
        { paths: [A], now: [0, 0], answers: { [A]: true } },
        { paths: [A], now: 1e8 },
      ],
    ],
    note: 'a long time',
  },
  {
    args: [
      {},
      [
        { paths: [A], now: [1000, 500], answers: { [A]: true } },
        { paths: [A], now: 400 },
        { paths: [A], now: 60_499 },
        { paths: [A], now: [60_500, 60_500], answers: { [A]: false } },
      ],
    ],
    note: 'a clock that goes back',
  },
  {
    args: [
      {},
      [
        { paths: [A, B], now: [0, 0], answers: { [A]: true, [B]: true, [C]: false } },
        { paths: [C], now: [1, 1], answers: { [C]: false } },
      ],
    ],
    note: 'an answer for a path that was not asked is dropped',
  },
]

// ---------------------------------------------------------------------------

export const cloud: Group = {
  'cloud-files.FILE_ATTRIBUTE_OFFLINE': constant(FILE_ATTRIBUTE_OFFLINE),
  'cloud-files.FILE_ATTRIBUTE_RECALL_ON_OPEN': constant(FILE_ATTRIBUTE_RECALL_ON_OPEN),
  'cloud-files.FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS': constant(
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  ),
  'cloud-files.CLOUD_ONLY_ATTRIBUTES': constant(CLOUD_ONLY_ATTRIBUTES),
  'cloud-files.DEFAULT_LISTING_TIMEOUT_MS': constant(DEFAULT_LISTING_TIMEOUT_MS),
  'cloud-files.POWERSHELL_LISTING_SCRIPT': constant(POWERSHELL_LISTING_SCRIPT),
  'cloud-files.isCloudOnlyAttributes': {
    ts: (a) => isCloudOnlyAttributes(a[0] as number),
    cases: ATTRIBUTE_CASES.map((n): Case => ({ args: [n] })),
  },
  'cloud-files.parseAttributeListing': {
    ts: (a) => listingPairs(parseAttributeListing(a[0] as string, a[1] as string[])),
    cases: LISTING_CASES.map(([stdout, dirs]): Case => ({ args: [stdout, dirs] })),
  },
  'cloud-files.createPowerShellAttributeReader': {
    ts: async (a, cx) => {
      const cfg = a[0] as { env?: Env; run: RunCfg }
      const reader = makeReader(cfg, cx)
      if (reader === undefined) throw new Error('no reader')
      return listingPairs(await reader(a[1] as string[], { timeoutMs: a[2] as number }))
    },
    cases: READER_CASES,
  },
  'cloud-files.detectCloudOnlyFiles': {
    ts: async (a, cx) => {
      const cfg = a[1] as DetectCfg
      const reader = makeReader(cfg.reader, cx)
      return pairs(
        await detectCloudOnlyFiles(a[0] as string[], {
          platform: cfg.platform as NodeJS.Platform,
          ...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
          ...(reader === undefined ? {} : { reader }),
        }),
      )
    },
    cases: DETECT_CASES,
  },
  'cloud-files.knownSyncFolders': {
    ts: (a) => knownSyncFolders(a[0] as Env, syncOptions(a[1] as SyncCfg)),
    cases: KNOWN_CASES,
  },
  'cloud-files.isOnGoogleDriveStream': {
    ts: (a) => isOnGoogleDriveStream(a[0] as string, a[1] as NodeJS.Platform),
    cases: GOOGLE_CASES.map(([path, platform]): Case => ({ args: [path, platform] })),
  },
  'cloud-files.isUnderKnownSyncFolder': {
    ts: (a) => isUnderKnownSyncFolder(a[0] as string, a[1] as Env, syncOptions(a[2] as SyncCfg)),
    cases: UNDER_CASES,
  },
  'cloud-files.resolveCloudOnly': {
    ts: async (a, cx) => {
      const cfg = a[2] as ResolveCfg
      const reader = makeReader(cfg.reader, cx)
      return pairs(
        await resolveCloudOnly(a[0] as string[], {
          ...syncOptions(cfg),
          env: a[1] as Env,
          ...(cfg.timeoutMs === undefined ? {} : { timeoutMs: cfg.timeoutMs }),
          ...(reader === undefined ? {} : { reader }),
        }),
      )
    },
    cases: RESOLVE_CASES,
  },
  'cloud-cache.CONTEXT_CLOUD_CACHE_MS': constant(CONTEXT_CLOUD_CACHE_MS),
  'cloud-cache.createCachedCloudResolver': {
    ts: (a, cx) => runCache(a[0] as { ttlMs?: number }, a[1] as CacheOp[], cx),
    cases: CACHE_CASES,
  },
}
