/**
 * Group `update`: update-attempt.ts, update-cache.ts, update-build-channel.ts,
 * update-log.ts and launch-paths.ts of apps/shell/src/main.
 */
import {
  INSTALL_ATTEMPT_FILE,
  clearInstallAttempt,
  installDidNotApply,
  installDirWritable,
  installFailureLevel,
  nextAttemptTries,
  readInstallAttempt,
  recordInstallAttempt,
  type InstallAttempt,
} from '../../../apps/shell/src/main/update-attempt.ts'
import { pruneUpdateCache } from '../../../apps/shell/src/main/update-cache.ts'
import {
  buildChannelFromAppUpdateYml,
  packagedUpdateChannel,
} from '../../../apps/shell/src/main/update-build-channel.ts'
import {
  UPDATE_LOG_FILE,
  UPDATE_LOG_MAX_BYTES,
  createUpdateLog,
  createUpdateSteps,
  fileBytes,
  type UpdateStep,
  type UpdateStepFields,
} from '../../../apps/shell/src/main/update-log.ts'
import {
  LAUNCHABLE_DOUBLE_EXTS,
  LAUNCHABLE_EXTS,
  LAUNCHABLE_UNCLAIMED_EXTS,
  collectLaunchPaths,
} from '../../../apps/shell/src/main/launch-paths.ts'
import type { Case, Group } from '../types.ts'

const ATTEMPT = 'update-install-attempt.json'
const A = (extra: object = {}): object => ({
  version: '1.2.0',
  fromVersion: '1.1.0',
  visible: false,
  ...extra,
})
const attemptFile = (value: unknown): string => JSON.stringify(value)

/** A constant: two cases whose folders differ, so the answers do. */
const constantCases: Case[] = [
  { args: [], note: 'empty folder' },
  { args: [], files: { 'x.txt': 'x' }, note: 'a file in the folder' },
]

export const group: Group = {
  // ---------- update-attempt.ts ----------
  'update-attempt.INSTALL_ATTEMPT_FILE': {
    ts: () => INSTALL_ATTEMPT_FILE,
    cases: constantCases,
  },
  'update-attempt.nextAttemptTries': {
    ts: (a) => nextAttemptTries(a[0] as InstallAttempt | null, a[1] as string),
    cases: [
      { args: [null, '1.2.0'], note: 'no failed attempt' },
      { args: [A({ tries: 3 }), '1.2.0'], note: 'same version, count kept' },
      { args: [A({ tries: 3 }), '1.3.0'], note: 'other version restarts' },
      { args: [A(), '1.2.0'], note: 'old record, silent start is one try' },
      { args: [A({ visible: true }), '1.2.0'], note: 'old record, visible start is two tries' },
      {
        args: [A({ tries: 1.5, startedAt: '2026-01-01T00:00:00.000Z' }), '1.2.0'],
        note: 'fractional count',
      },
      { args: [A({ tries: 1e21 }), '1.2.0'], note: 'huge count prints as 1e+21' },
      { args: [A({ version: '\u{1F600}' }), '\u{1F600}'], note: 'astral version' },
      { args: [A({ version: '' }), ''], note: 'empty versions equal' },
    ],
  },
  'update-attempt.recordInstallAttempt': {
    ts: (a) => recordInstallAttempt(a[0] as string, a[1] as InstallAttempt),
    cases: [
      { args: ['$DIR', A()], note: 'minimal record' },
      {
        args: ['$DIR', A({ tries: 2, startedAt: '2026-11-12T03:00:00.000Z' })],
        note: 'every field',
      },
      { args: ['$DIR', A({ visible: true, tries: 1.5 })], note: 'fractional tries are written' },
      {
        args: ['$DIR', A({ version: '\u0131\u017F\u212A\u{1F600}', startedAt: 'a"b\\c\n' })],
        note: 'escapes and non-ASCII',
      },
      {
        args: ['$DIR', A({ tries: 7 })],
        files: { [ATTEMPT]: 'old and much longer content than the new record will be' },
        note: 'overwrites',
      },
      { args: ['$DIR/missing', A()], note: 'folder missing: swallowed' },
      {
        args: ['$DIR', A()],
        files: { [ATTEMPT]: { dir: true } },
        note: 'target is a folder: swallowed',
      },
      { args: ['$DIR/', A({ tries: 1e21 })], note: 'trailing slash, 1e+21' },
      { args: ['$DIR//sub/../', A()], files: { sub: { dir: true } }, note: 'join normalizes' },
    ],
  },
  'update-attempt.readInstallAttempt': {
    ts: (a) => readInstallAttempt(a[0] as string),
    cases: [
      { args: ['$DIR'], note: 'no file' },
      { args: ['$DIR'], files: { [ATTEMPT]: attemptFile(A()) }, note: 'minimal' },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ tries: 2, startedAt: 's' })) },
        note: 'all fields',
      },
      {
        args: ['$DIR'],
        files: {
          [ATTEMPT]:
            '{"b":1,"version":"1","10":"x","fromVersion":"0","2":"y","visible":true,"a":[1.50,1e21]}',
        },
        note: 'extra keys stay, integer-like keys first',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: '{"version":"1","version":"2","fromVersion":"0","visible":false}' },
        note: 'duplicate key',
      },
      { args: ['$DIR'], files: { [ATTEMPT]: attemptFile(A({ tries: 0 })) }, note: 'tries below 1' },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ tries: 1.5 })) },
        note: 'tries not an integer',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ tries: '2' })) },
        note: 'tries a string',
      },
      { args: ['$DIR'], files: { [ATTEMPT]: attemptFile(A({ tries: null })) }, note: 'tries null' },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: '{"version":"1","fromVersion":"0","visible":true,"tries":1e400}' },
        note: 'tries Infinity',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: '{"version":"1","fromVersion":"0","visible":true,"tries":1e21}' },
        note: 'tries 1e21 is an integer',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: '{"version":"1","fromVersion":"0","visible":true,"tries":3.0}' },
        note: 'tries 3.0',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ startedAt: 5 })) },
        note: 'startedAt a number',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ visible: 'no' })) },
        note: 'visible a string',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ version: '' })) },
        note: 'empty version',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ fromVersion: '' })) },
        note: 'empty fromVersion',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: '{"version":"1","visible":true}' },
        note: 'fromVersion missing',
      },
      { args: ['$DIR'], files: { [ATTEMPT]: '[]' }, note: 'array' },
      { args: ['$DIR'], files: { [ATTEMPT]: 'null' }, note: 'null' },
      { args: ['$DIR'], files: { [ATTEMPT]: '"text"' }, note: 'string' },
      { args: ['$DIR'], files: { [ATTEMPT]: '' }, note: 'empty file' },
      { args: ['$DIR'], files: { [ATTEMPT]: '{"version":' }, note: 'truncated' },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: '\uFEFF' + attemptFile(A()) },
        note: 'BOM is not JSON white space',
      },
      {
        args: ['$DIR'],
        files: {
          [ATTEMPT]: {
            hex: Buffer.from(attemptFile(A({ startedAt: 'X' })))
              .toString('hex')
              .replace('58', 'ff'),
          },
        },
        note: 'invalid UTF-8 becomes U+FFFD',
      },
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A({ version: '\u{1F600}\u0131' })) },
        note: 'non-ASCII',
      },
      { args: ['$DIR'], files: { [ATTEMPT]: { dir: true } }, note: 'a folder' },
      {
        args: ['$DIR'],
        files: {
          [ATTEMPT]: '{"__proto__":{"x":1},"version":"1","fromVersion":"0","visible":true}',
        },
        note: '__proto__ key',
      },
    ],
  },
  'update-attempt.clearInstallAttempt': {
    ts: (a) => clearInstallAttempt(a[0] as string),
    cases: [
      {
        args: ['$DIR'],
        files: { [ATTEMPT]: attemptFile(A()), keep: 'k' },
        note: 'removes the record',
      },
      { args: ['$DIR'], note: 'already gone' },
      { args: ['$DIR'], files: { [ATTEMPT]: { dir: true } }, note: 'a folder stays' },
      { args: ['$DIR/missing'], note: 'folder missing' },
    ],
  },
  'update-attempt.installDidNotApply': {
    ts: (a) => installDidNotApply(a[0] as InstallAttempt | null, a[1] as string),
    cases: [
      { args: [null, '1.1.0'], note: 'no attempt' },
      { args: [A(), '1.1.0'], note: 'still on the old version' },
      { args: [A(), '1.2.0'], note: 'updated' },
      { args: [A(), '9.9.9'], note: 'some other version' },
      { args: [A({ version: '1.1.0' }), '1.1.0'], note: 'target equals current' },
      { args: [A({ version: '\u{1F600}', fromVersion: '\u0131' }), '\u0131'], note: 'non-ASCII' },
    ],
  },
  'update-attempt.installFailureLevel': {
    ts: (a) => installFailureLevel(a[0] as InstallAttempt | null),
    cases: [
      { args: [null] },
      { args: [A({ tries: 1 })], note: 'one try' },
      { args: [A({ tries: 2 })], note: 'two tries' },
      { args: [A({ tries: 9 })], note: 'many tries' },
      { args: [A()], note: 'old silent record' },
      { args: [A({ visible: true })], note: 'old visible record' },
      { args: [A({ tries: 1.5 })], note: 'fractional below two' },
      { args: [A({ tries: 2.5 })], note: 'fractional above two' },
    ],
  },
  'update-attempt.installDirWritable': {
    ts: (a) => installDirWritable(a[0] as string, a[1] as string),
    cases: [
      { args: ['$DIR', '.probe'], note: 'writable, probe removed' },
      {
        args: ['$DIR', '.probe'],
        files: { '.probe': 'left by a crash' },
        note: 'EEXIST counts as writable',
      },
      {
        args: ['$DIR', '.probe'],
        files: { '.probe': { dir: true } },
        note: 'probe name is a folder',
      },
      { args: ['$DIR/missing', '.probe'], note: 'folder missing' },
      { args: ['$DIR/f', '.probe'], files: { f: 'a file' }, note: 'install dir is a file' },
      {
        args: ['$DIR/ro', '.probe'],
        files: { ro: { dir: true, mode: 0o555 } },
        note: 'read-only folder',
      },
      { args: ['$DIR', ''], note: 'empty probe name is the folder itself' },
      { args: ['$DIR', '\u{1F600}\u0131.tmp'], note: 'non-ASCII probe' },
      { args: ['$DIR', 'sub/p'], files: { sub: { dir: true } }, note: 'nested probe' },
      { args: ['$DIR', 'nosub/p'], note: 'nested probe, parent missing' },
      { args: ['$DIR', '../escape-probe-never-exists/x'], note: 'parent missing via ..' },
    ],
  },

  // ---------- update-cache.ts ----------
  'update-cache.pruneUpdateCache': {
    ts: (a, cx) => {
      const o = a[0] as { cacheDir: string; runningVersion: string }
      return pruneUpdateCache({
        cacheDir: o.cacheDir,
        runningVersion: o.runningVersion,
        log: cx.log,
      })
    },
    cases: (() => {
      const P = 'pending/'
      const info = (fileName: unknown): string => JSON.stringify({ fileName, sha512: 'x' })
      const run = (v: string): unknown[] => [{ cacheDir: '$DIR', runningVersion: v }]
      const exe = 'seuoffice-setup-1.2.3-x64-stable.exe'
      const cases: Case[] = [
        { args: run('1.2.3'), note: 'no pending folder' },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'running version: both removed',
        },
        {
          args: run('1.2.4'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'older download',
        },
        {
          args: run('1.2.2'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'newer download stays',
        },
        {
          args: run('1.3.0'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'minor compared before patch',
        },
        {
          args: run('0.9.9'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'major newer',
        },
        {
          args: run('1.2.3-beta.1'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'equal numbers, running pre-release: stays',
        },
        {
          args: run('1.2.3+build'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'build metadata is no pre-release',
        },
        {
          args: run('v1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'running version without leading digits',
        },
        {
          args: run('1.2'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe) },
          note: 'two numbers only',
        },
        {
          args: run('1.2.3'),
          files: { [P + 'update-info.json']: info(exe) },
          note: 'installer already gone, record removed',
        },
        { args: run('1.2.3'), files: { [P + exe]: 'i' }, note: 'no record' },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: '{' },
          note: 'record malformed',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: '\uFEFF' + info(exe) },
          note: 'record with BOM',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: 'null' },
          note: 'record null',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: '"fileName"' },
          note: 'record a string',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: '[]' },
          note: 'record an array',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(5) },
          note: 'fileName a number',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info('sub/' + exe) },
          note: 'fileName with a path',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: 'i', [P + 'update-info.json']: info(exe + '/') },
          note: 'fileName with a trailing slash',
        },
        {
          args: run('1.2.3'),
          files: { [P + 'update-info.json']: info('..') },
          note: 'fileName ..',
        },
        {
          args: run('1.2.3'),
          files: { [P + 'update-info.json']: info('') },
          note: 'fileName empty',
        },
        {
          args: run('1.2.3'),
          files: { [P + 'update-info.json']: info('setup.exe') },
          note: 'name without a version is not judged',
        },
        {
          args: run('1.2.3'),
          files: { [P + 'update-info.json']: info('setup-1.2.3') },
          note: 'version at the end has no lookahead',
        },
        {
          args: run('1.2.3'),
          files: {
            [P + 'setup-1.2.3.exe']: 'i',
            [P + 'update-info.json']: info('setup-1.2.3.exe'),
          },
          note: 'dot after the version',
        },
        {
          args: run('1.0.0'),
          files: {
            [P + 'a-99999999999999999999.0.0-x.exe']: 'i',
            [P + 'update-info.json']: info('a-99999999999999999999.0.0-x.exe'),
          },
          note: 'huge number',
        },
        {
          args: run('99999999999999999999.0.0'),
          files: { [P + 'a-1.0.0-x.exe']: 'i', [P + 'update-info.json']: info('a-1.0.0-x.exe') },
          note: 'huge running number',
        },
        {
          args: run('1.2.3'),
          files: {
            [P + '\u{1F600}-\u0131-1.2.3-x.exe']: 'i',
            [P + 'update-info.json']: info('\u{1F600}-\u0131-1.2.3-x.exe'),
          },
          note: 'non-ASCII name',
        },
        {
          args: run('1.2.3'),
          files: { [P + exe]: { dir: true }, [P + 'update-info.json']: info(exe) },
          note: 'the named file is a folder: ERR_FS_EISDIR',
        },
        {
          args: run('1.2.3'),
          files: {
            [P + exe]: 'i',
            [P + 'update-info.json']: { text: info(exe) },
            pending: { dir: true, mode: 0o555 },
          },
          note: 'read-only pending folder',
        },
        {
          args: [{ cacheDir: '$DIR/none', runningVersion: '1.2.3' }],
          note: 'cache folder missing',
        },
        {
          args: run('1.2.3'),
          files: { pending: 'a file, not a folder' },
          note: 'pending is a file',
        },
        {
          args: run('1.2.3'),
          files: { [P + 'temp-1.2.3-x.exe']: 'partial', [P + 'update-info.json']: info(exe) },
          note: 'partial download untouched',
        },
      ]
      return cases
    })(),
  },

  // ---------- update-build-channel.ts ----------
  'update-build-channel.buildChannelFromAppUpdateYml': {
    ts: (a) => buildChannelFromAppUpdateYml(a[0] as string),
    cases: [
      { args: ['channel: latest\n'] },
      { args: ['channel: stable\n'] },
      { args: [''], note: 'empty' },
      {
        args: [
          'provider: github\nowner: x\nchannel: latest\nupdaterCacheDirName: seuoffice-updater\n',
        ],
        note: 'later line',
      },
      { args: ["channel: 'latest'\n"], note: 'single quotes' },
      { args: ['channel: "latest"\n'], note: 'double quotes' },
      { args: ['channel: "latest\''], note: 'mixed quotes' },
      { args: ['channel: latest'], note: 'no newline' },
      { args: ['channel: latest\r\nx: y\r\n'], note: 'CRLF' },
      { args: ['channel:latest'], note: 'no space' },
      { args: ['channel:\nlatest'], note: 'the white space spans the line break' },
      { args: ['channel:\n\nlatest\n'], note: 'blank lines' },
      { args: [' channel: latest'], note: 'indented' },
      { args: ['x: 1\n channel: latest\nchannel: stable\n'], note: 'only a line start counts' },
      { args: ['channel: beta\nchannel: latest\n'], note: 'first match decides' },
      { args: ['channel: latest-beta\n'], note: 'longer name' },
      { args: ['channel: Latest\n'], note: 'case matters' },
      { args: ['channel: latest # c\n'], note: 'trailing comment' },
      { args: ['channel: latest\u00A0\n'], note: 'NBSP is white space' },
      { args: ['channel: latest\uFEFF\n'], note: 'U+FEFF is white space' },
      { args: ['channel: latest\u0085\n'], note: 'U+0085 is not' },
      { args: ['x\u2028channel: latest'], note: 'U+2028 starts a line' },
      { args: ['channel: latest\u2029x'], note: 'U+2029 ends a line' },
      { args: ['x\rchannel: latest'], note: 'CR starts a line' },
      { args: ['channel: lat\u212Aest\n'], note: 'Kelvin sign is no k' },
      { args: ['channel: \u{1F600}\n'], note: 'astral' },
      { args: ['channel: \u0131\n'], note: 'dotless i' },
      { args: ['channel: _-9\n'], note: 'other name' },
      { args: ['channel: "latest"x\n'], note: 'junk after the quote' },
    ],
  },
  'update-build-channel.packagedUpdateChannel': {
    ts: (a) => {
      const p = process as unknown as { resourcesPath?: string }
      const before = p.resourcesPath
      p.resourcesPath = a[0] as string
      try {
        return packagedUpdateChannel()
      } finally {
        p.resourcesPath = before
      }
    },
    cases: [
      { args: ['$DIR'], files: { 'app-update.yml': 'channel: latest\n' }, note: 'latest' },
      { args: ['$DIR'], files: { 'app-update.yml': 'channel: stable\n' }, note: 'stable' },
      { args: ['$DIR'], note: 'no file' },
      { args: ['$DIR'], files: { 'app-update.yml': { dir: true } }, note: 'a folder' },
      { args: ['$DIR/none'], note: 'resources folder missing' },
      {
        args: ['$DIR'],
        files: { 'app-update.yml': { hex: 'ff0a6368616e6e656c3a206c6174657374' } },
        note: 'invalid UTF-8 before the line',
      },
      {
        args: ['$DIR'],
        files: { 'app-update.yml': '\uFEFFchannel: latest\n' },
        note: 'BOM stays and hides the line start',
      },
      { args: ['$DIR/'], files: { 'app-update.yml': 'channel: latest' }, note: 'trailing slash' },
      { args: ['$DIR'], files: { 'app-update.yml': '' }, note: 'empty file' },
    ],
  },

  // ---------- update-log.ts ----------
  'update-log.UPDATE_LOG_FILE': { ts: () => UPDATE_LOG_FILE, cases: constantCases },
  'update-log.UPDATE_LOG_MAX_BYTES': { ts: () => UPDATE_LOG_MAX_BYTES, cases: constantCases },
  'update-log.createUpdateLog': {
    ts: (a, cx) => {
      const [file, maxBytes, calls, nowMs] = a as [
        string,
        number | null,
        [string, unknown][],
        number | null,
      ]
      const log = createUpdateLog(
        file,
        maxBytes ?? undefined,
        () => new Date(nowMs ?? cx.now),
      ) as unknown as Record<string, (m: unknown) => void>
      const message = (spec: unknown): unknown => {
        if (spec && typeof spec === 'object' && '$undefined' in spec) return undefined
        if (spec && typeof spec === 'object' && '$error' in spec) {
          const e = (spec as { $error: { stack: string | null; message: string } }).$error
          const err = new Error(e.message)
          err.stack = e.stack ?? undefined
          return err
        }
        return spec
      }
      for (const [level, spec] of calls) log[level](message(spec))
    },
    cases: (() => {
      const L = '$DIR/update-log.txt'
      const NOW = 1_794_452_400_000
      const cases: Case[] = [
        { args: [L, null, [['info', 'started']], null], note: 'one line' },
        {
          args: [
            L,
            null,
            [
              ['info', 'a'],
              ['warn', 'b'],
              ['error', 'c'],
              ['debug', 'd'],
            ],
            null,
          ],
          note: 'every level',
        },
        {
          args: [L, null, [['info', 'a']], null],
          files: { 'update-log.txt': 'earlier\n' },
          note: 'appends',
        },
        {
          args: [L, null, [['info', 'a\nb\r\nc\rd\n\n']], null],
          note: 'line breaks become |, a lone CR stays',
        },
        { args: [L, null, [['info', '']], null], note: 'empty message' },
        { args: [L, null, [['info', { $undefined: true }]], null], note: 'undefined' },
        {
          args: [
            L,
            null,
            [
              ['info', null],
              ['info', 5],
              ['info', true],
              ['info', 1e21],
              ['info', 0.1],
              ['info', -0],
            ],
            null,
          ],
          note: 'primitives',
        },
        {
          args: [L, null, [['warn', { b: 1, 2: 'x', a: [1, null, 'é'], 10: {} }]], null],
          note: 'objects keep JavaScript key order',
        },
        {
          args: [L, null, [['info', ['line\nbreak', '\u{1F600}']]], null],
          note: 'JSON escapes the newline, so no |',
        },
        {
          args: [
            L,
            null,
            [
              [
                'error',
                { $error: { stack: 'Error: x\n    at f (a.js:1:1)\n    at g', message: 'x' } },
              ],
            ],
            null,
          ],
          note: 'Error with a stack',
        },
        {
          args: [L, null, [['error', { $error: { stack: null, message: 'plain message' } }]], null],
          note: 'Error without a stack',
        },
        {
          args: [L, null, [['error', { $error: { stack: '', message: 'kept' } }]], null],
          note: 'empty stack is kept',
        },
        { args: [L, null, [['info', 'x'.repeat(5000)]], null], note: 'cut at 4096' },
        {
          args: [L, null, [['info', 'x'.repeat(4095) + '\u{1F600}tail']], null],
          note: 'cut inside a surrogate pair',
        },
        {
          args: [L, null, [['info', 'x'.repeat(4094) + '\u{1F600}tail']], null],
          note: 'pair ends exactly at the cut',
        },
        {
          args: [L, null, [['info', '\n'.repeat(3000)]], null],
          note: 'a break counts once replaced, after expansion',
        },
        {
          args: [L, null, [['info', '\u0131\u017F\u212A\u{1F600} text']], null],
          note: 'non-ASCII',
        },
        { args: [L, null, [['info', 'a']], 0], note: 'epoch' },
        { args: [L, null, [['info', 'a']], -1], note: 'one ms before the epoch' },
        { args: [L, null, [['info', 'a']], -0.5], note: 'fraction toward zero' },
        { args: [L, null, [['info', 'a']], 1.9], note: 'fraction' },
        { args: [L, null, [['info', 'a']], 951782400000], note: 'leap day' },
        { args: [L, null, [['info', 'a']], 253402300799999], note: 'last ms of year 9999' },
        { args: [L, null, [['info', 'a']], 253402300800000], note: 'year 10000' },
        { args: [L, null, [['info', 'a']], -62167219200000], note: 'year 0' },
        { args: [L, null, [['info', 'a']], -62198755200000], note: 'year -1' },
        { args: [L, null, [['info', 'a']], 8.64e15], note: 'largest date' },
        { args: [L, null, [['info', 'a']], -8.64e15], note: 'smallest date' },
        {
          args: [L, null, [['info', 'a']], 8.64e15 + 1],
          note: 'invalid date: RangeError swallowed, nothing written',
        },
        {
          args: [
            L,
            120,
            [
              ['info', 'one'],
              ['info', 'two'],
              ['info', 'three'],
              ['info', 'four'],
              ['info', 'five'],
            ],
            null,
          ],
          note: 'trimmed from the older half',
        },
        {
          args: [
            L,
            60,
            [
              ['info', 'a'],
              ['info', 'b'],
            ],
            null,
          ],
          note: 'trimmed on the second line',
        },
        {
          args: [L, 0, [['info', 'only']], null],
          note: 'a single entry over the limit leaves nothing',
        },
        { args: [L, -1, [['info', 'x']], null], note: 'negative limit' },
        {
          args: [
            L,
            40.5,
            [
              ['info', 'x'],
              ['info', 'y'],
            ],
            null,
          ],
          note: 'fractional limit',
        },
        {
          args: [L, 100, [['info', 'new']], null],
          files: {
            'update-log.txt': 'old line 1\nold line 2\nold line 3\nold line 4\nold line 5\n',
          },
          note: 'existing file over the limit',
        },
        {
          args: [L, 100, [['info', 'new']], null],
          files: { 'update-log.txt': 'x'.repeat(200) },
          note: 'no line break after the middle',
        },
        {
          args: [L, 100, [['info', 'new']], null],
          files: {
            'update-log.txt': '\u{1F600}'.repeat(30) + '\nB\n' + '\u0131'.repeat(30) + '\nC\n',
          },
          note: 'the middle falls inside an astral run (UTF-16 units)',
        },
        {
          args: [L, 100, [['info', 'new']], null],
          files: { 'update-log.txt': '\u{1F600}\n'.repeat(15) },
          note: 'split point between the two units of a pair',
        },
        {
          args: [L, 100, [['info', 'new']], null],
          files: { 'update-log.txt': { hex: 'ff'.repeat(60) + '0a' + 'fe'.repeat(60) } },
          note: 'invalid UTF-8 in the file when trimming',
        },
        {
          args: [L, 1000, [['info', 'new']], null],
          files: { 'update-log.txt': 'x'.repeat(900) },
          note: 'within the limit after append',
        },
        { args: ['$DIR/none/update-log.txt', null, [['info', 'a']], null], note: 'folder missing' },
        {
          args: [L, null, [['info', 'a']], null],
          files: { 'update-log.txt': { dir: true } },
          note: 'the log is a folder',
        },
        {
          args: ['$DIR/ro/update-log.txt', null, [['info', 'a']], null],
          files: { ro: { dir: true, mode: 0o555 } },
          note: 'read-only folder',
        },
        { args: [L, null, [], null], note: 'no calls' },
        {
          args: [
            L,
            1_000_000,
            [
              ['info', 'a'],
              ['info', 'b'],
            ],
            NOW,
          ],
          note: 'explicit clock',
        },
        {
          args: [L, 50, [['info', 'new']], 1_794_452_400_000],
          files: { 'update-log.txt': `${'a'.repeat(38)}\nbbb\n` },
          note: 'odd length 77 (43 + a 34-char entry): the newline at index 38 is skipped from keepFrom 39 but found from 38',
        },
      ]
      return cases
    })(),
  },
  'update-log.createUpdateSteps': {
    ts: (a, cx) => {
      const calls = a[0] as [string, UpdateStepFields | null, number][]
      let clock = 0
      const step = createUpdateSteps(
        (line) => cx.log(line),
        () => clock,
      )
      for (const [name, fields, now] of calls) {
        clock = now
        if (fields === null) step(name as UpdateStep)
        else step(name as UpdateStep, fields)
      }
    },
    cases: [
      { args: [[['check-start', null, 100]]], note: 'start' },
      {
        args: [
          [
            ['check-start', null, 100],
            ['check-end', null, 350.4],
          ],
        ],
        note: 'end with ms',
      },
      {
        args: [
          [
            ['check-start', null, 100],
            ['check-end', null, 102.5],
          ],
        ],
        note: 'rounds .5 up',
      },
      {
        args: [
          [
            ['check-start', null, 100.5],
            ['check-end', null, 100],
          ],
        ],
        note: 'negative half rounds toward zero (-0.5)',
      },
      {
        args: [
          [
            ['check-start', null, 100],
            ['check-end', null, 97.5],
          ],
        ],
        note: '-2.5 rounds to -2',
      },
      {
        args: [
          [
            ['check-start', null, 0],
            ['check-end', null, 1e21],
          ],
        ],
        note: 'huge span prints as 1e+21',
      },
      { args: [[['check-end', null, 5]]], note: 'end without a start' },
      {
        args: [
          [
            ['check-start', null, 1],
            ['check-end', null, 2],
            ['check-end', null, 3],
          ],
        ],
        note: 'the start is spent',
      },
      {
        args: [
          [
            ['check-start', null, 1],
            ['check-start', null, 10],
            ['check-end', null, 12],
          ],
        ],
        note: 'second start wins',
      },
      {
        args: [
          [
            ['download-start', null, 1],
            ['check-end', null, 5],
          ],
        ],
        note: 'other span',
      },
      {
        args: [
          [
            ['a-start', null, 1],
            ['b-start', null, 2],
            ['b-end', null, 9],
            ['a-end', null, 11],
          ],
        ],
        note: 'nested spans',
      },
      {
        args: [
          [
            ['will-quit', null, 1],
            ['installer-start', { version: '1.2.0' }, 2],
          ],
        ],
        note: 'step without a pair',
      },
      {
        args: [
          [
            ['check-start-end', null, 1],
            ['check-start-start', null, 2],
            ['check-start-end', null, 5],
          ],
        ],
        note: 'span of a doubled suffix',
      },
      {
        args: [
          [
            ['-start', null, 1],
            ['-end', null, 3],
          ],
        ],
        note: 'empty span',
      },
      {
        args: [
          [
            ['start', null, 1],
            ['end', null, 3],
          ],
        ],
        note: 'no dash',
      },
      {
        args: [[['app-started', { fromVersion: '1.1.0', ms: 5, none: null }, 1]]],
        note: 'null left out',
      },
      {
        args: [[['app-started', { a: 'x y', b: ' lead\ttab\nnl ', c: '' }, 1]]],
        note: 'white space becomes _',
      },
      {
        args: [
          [
            [
              'app-started',
              { a: 'a\u00A0b\uFEFFc\u2028d\u0085e', b: '\u{1F600} \u0131 \u017F \u212A' },
              1,
            ],
          ],
        ],
        note: 'JavaScript white space, non-ASCII',
      },
      {
        args: [[['app-started', { n: 0, m: 1.5, big: 1e21, small: 1e-7, neg: -3 }, 1]]],
        note: 'numbers',
      },
      {
        args: [[['app-started', { b: 'x', 2: 'two', a: 'y', 10: 'ten', 1: 'one' }, 1]]],
        note: 'integer-like keys first',
      },
      { args: [[['app-started', { t: true, f: false }, 1]]], note: 'booleans' },
      { args: [[['app-started', {}, 1]]], note: 'empty fields' },
      { args: [[['app-started', { 'k k': 'v' }, 1]]], note: 'key with a space is not changed' },
      { args: [[]], note: 'no calls' },
    ],
  },
  'update-log.fileBytes': {
    ts: (a) => fileBytes(a[0]),
    cases: [
      { args: ['$DIR/f'], files: { f: 'hello' }, note: '5 bytes' },
      { args: ['$DIR/f'], files: { f: '' }, note: 'empty file' },
      { args: ['$DIR/f'], files: { f: '\u{1F600}\u0131' }, note: 'UTF-8 bytes' },
      { args: ['$DIR/f'], files: { f: { hex: '00ff'.repeat(10000) } }, note: 'binary' },
      { args: ['$DIR/none'], note: 'missing' },
      { args: [''], note: 'empty path' },
      { args: [123], note: 'a number' },
      { args: [null], note: 'null' },
      { args: [], note: 'undefined' },
      { args: [['$DIR/f']], files: { f: 'x' }, note: 'an array' },
      { args: ['$DIR/d'], files: { d: { dir: true } }, note: 'a folder' },
    ],
  },

  // ---------- launch-paths.ts ----------
  'launch-paths.LAUNCHABLE_EXTS': { ts: () => [...LAUNCHABLE_EXTS], cases: constantCases },
  'launch-paths.LAUNCHABLE_DOUBLE_EXTS': {
    ts: () => [...LAUNCHABLE_DOUBLE_EXTS],
    cases: constantCases,
  },
  'launch-paths.LAUNCHABLE_UNCLAIMED_EXTS': {
    ts: () => [...LAUNCHABLE_UNCLAIMED_EXTS],
    cases: constantCases,
  },
  'launch-paths.collectLaunchPaths': {
    ts: (a) => collectLaunchPaths(a[0] as string[], a[1]),
    cases: (() => {
      const D = '$DIR/'
      const all = [...LAUNCHABLE_EXTS, ...LAUNCHABLE_UNCLAIMED_EXTS, ...LAUNCHABLE_DOUBLE_EXTS]
      const every = Object.fromEntries(all.map((e) => [`f.${e}`, 'x']))
      const cases: Case[] = [
        { args: [[]], note: 'empty argv' },
        { args: [[D + 'a.docx']], files: { 'a.docx': 'x' }, note: 'supported, exists' },
        { args: [[D + 'a.docx']], note: 'supported, missing' },
        { args: [all.map((e) => `${D}f.${e}`)], files: every, note: 'every extension, in order' },
        {
          args: [all.map((e) => `${D}f.${e.toUpperCase()}`)],
          files: every,
          note: 'upper case (case-folded by i; the names exist only as lower case on a case-sensitive disk)',
        },
        {
          args: [[D + 'A.DOCX', D + 'b.Drawio.SVG', D + 'c.DrAwIo.PnG']],
          files: { 'A.DOCX': 'x', 'b.Drawio.SVG': 'x', 'c.DrAwIo.PnG': 'x' },
          note: 'mixed case',
        },
        {
          args: [
            [
              D + 'a.svg',
              D + 'a.png',
              D + 'a.drawio.jpg',
              D + 'a.docx.bak',
              D + 'a.docx ',
              D + 'a.docx\n',
              D + 'a.docx\u0000',
            ],
          ],
          files: {
            'a.svg': 'x',
            'a.png': 'x',
            'a.drawio.jpg': 'x',
            'a.docx.bak': 'x',
            'a.docx ': 'x',
            'a.docx\n': 'x',
          },
          note: 'near misses; $ is end of text only',
        },
        {
          args: [[D + 'docx', D + '.docx']],
          files: { docx: 'x', '.docx': 'x' },
          note: 'a dot is required',
        },
        {
          args: [
            [
              D + 'a.d\u0131o',
              D + 'a.od\u017F',
              D + 'a.xl\u017F',
              D + 'a.c\u017Fv',
              D + 'a.mar\u212Adown',
              D + 'a.dr\u0131o.\u017Fvg',
            ],
          ],
          files: {
            'a.d\u0131o': 'x',
            'a.od\u017F': 'x',
            'a.xl\u017F': 'x',
            'a.c\u017Fv': 'x',
            'a.mar\u212Adown': 'x',
            'a.dr\u0131o.\u017Fvg': 'x',
          },
          note: 'dotless i, long s and Kelvin sign are not folded without the u flag',
        },
        {
          args: [[D + 'a.rtf', D + 'b.docx']],
          files: { 'a.rtf': 'x', 'b.docx': 'x' },
          note: 'fallback not used when a supported one exists',
        },
        {
          args: [[D + 'a.rtf', D + 'b.key']],
          files: { 'a.rtf': 'x', 'b.key': 'x' },
          note: 'fallback is the first existing unsupported',
        },
        {
          args: [[D + 'a.rtf', D + 'b.key']],
          files: { 'b.key': 'x' },
          note: 'first unsupported missing, second used',
        },
        {
          args: [[D + 'a.RTF', D + 'b.pps', D + 'c.XLSB', D + 'd.pages', D + 'e.numbers']],
          files: { 'e.numbers': 'x' },
          note: 'every unsupported extension',
        },
        { args: [[D + 'a.rtf']], files: { 'a.rtf': 'x' }, note: 'fallback alone' },
        { args: [[D + 'a.rtf']], note: 'fallback missing' },
        {
          args: [[D + 'a.rtf'], { launchPath: '/elsewhere/p.docx' }],
          files: { 'a.rtf': 'x' },
          note: 'payload blocks the fallback',
        },
        {
          args: [[D + 'a.rtf'], { launchPaths: [''] }],
          files: { 'a.rtf': 'x' },
          note: 'empty payload entries do not count',
        },
        {
          args: [[D + 'a.docx'], { launchPath: '/p/other.docx' }],
          files: { 'a.docx': 'x' },
          note: 'payload needs no existence',
        },
        {
          args: [
            [D + 'a.docx'],
            {
              launchPaths: ['/p/1.odt', 7, null, '', D + 'a.docx', ['x'], '/p/2.odt'],
              launchPath: '/p/3.odt',
            },
          ],
          files: { 'a.docx': 'x' },
          note: 'payload filtered, deduplicated, ordered',
        },
        {
          args: [[D + 'a.docx'], { launchPaths: ['/p/1.odt'], launchPath: '/p/1.odt' }],
          files: { 'a.docx': 'x' },
          note: 'duplicate inside payload',
        },
        { args: [[D + 'a.docx', D + 'a.docx']], files: { 'a.docx': 'x' }, note: 'duplicate argv' },
        {
          args: [[D + 'b.docx', D + 'a.docx']],
          files: { 'a.docx': 'x', 'b.docx': 'x' },
          note: 'argv order kept',
        },
        { args: [[], { launchPath: 'x' }], note: 'payload only' },
        { args: [[], { launchPath: '' }], note: 'empty launchPath' },
        { args: [[], { launchPath: 5, launchPaths: 'x' }], note: 'wrong types' },
        { args: [[], { launchPaths: { 0: 'x' } }], note: 'launchPaths an object' },
        { args: [[], 'text'], note: 'additionalData a string' },
        { args: [[], null], note: 'additionalData null' },
        { args: [[], 5], note: 'additionalData a number' },
        { args: [[], ['/x.docx']], note: 'additionalData an array' },
        { args: [[], {}], note: 'additionalData empty' },
        {
          args: [[D + '\u{1F600}.docx', D + '\u0131.txt']],
          files: { '\u{1F600}.docx': 'x', '\u0131.txt': 'x' },
          note: 'astral and non-ASCII names',
        },
        { args: [[D + 'sub']], files: { 'sub.docx': { dir: true } }, note: 'no extension' },
        {
          args: [[D + 'dir.docx']],
          files: { 'dir.docx': { dir: true } },
          note: 'a folder with a supported name exists',
        },
        { args: [['']], note: 'empty path' },
        { args: [['.docx']], note: 'relative name that does not exist' },
      ]
      return cases
    })(),
  },
}
