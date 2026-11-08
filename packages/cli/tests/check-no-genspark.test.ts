import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './helpers'

const SCRIPT = join(__dirname, '../../../tools/check-no-genspark.mjs')

let repo: string

function commit(files: Record<string, string | Buffer>): void {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true })
    writeFileSync(join(repo, name), body)
  }
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
}

function check(): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf-8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** line numbers the check reported for one file */
function reportedLines(stderr: string, file: string): number[] {
  const lines = new Set<number>()
  for (const m of stderr.matchAll(/^ {2}(.+?):(\d+): /gm)) {
    if (m[1] === file) lines.add(Number(m[2]))
  }
  return [...lines].sort((a, b) => a - b)
}

/** every line names the removed vendor, its company, its site, its community or its command line */
const MATCHING = [
  'genspark',
  'Sign in to Genspark',
  'const GENSPARK_LLM_BASE_URLS = {}',
  'GenSpark is an office suite',
  'https://www.genspark.ai/pricing',
  '"@genspark/cli": "^1.4.2"',
  'Copyleft Mainfunc, Inc.',
  'mainfunc',
  'https://genoffice.ai/',
  'see GenOffice.AI for details',
  'Join GenTeam',
  'const GENTEAM_URL = 1',
  'genteam',
  'gsk',
  'run gsk login first',
  'const key = gskApiKey()',
  'if (hasGskAuth()) return',
  'throw new GskAuthError(message)',
  '{ useGsk: false }',
  'process.env.GSK_API_KEY',
  'AI_SEARCH_DISABLE_GSK=1',
  'export const MAX_GSK_RESULTS = 20',
  'fn set_gsk_proxy() {}',
  'let _gsk = 1',
  "ipcMain.handle('ai:gsk-status', status)",
  "export * from './gsk'",
  'settings.gskToolsEnabled = true',
  'await runGsk(args)',
  'const useGSKBackend = true',
]

/** names that stay, and words that merely contain the three letters */
const CLEAN = [
  'GENOFFICE_AI_SETTINGS=/tmp/ai-settings.json',
  "import { x } from '@genoffice/ai-provider'",
  'const genofficeAiSettings = 1',
  'Based on the open-source project GenOffice (Apache License 2.0).',
  '.genoffice-assets.json',
  'open_in_genoffice',
  "t('intgSkillVersion', { v: bundled })",
  'BuildingSkyscraperRegular,',
  "export const TABLE_TRAILING_SKIP = 'tableTrailingSkip'",
  "ribbonTextHighlightColor: 'Markeringskleur voor tekst',",
  'sorteer eerst op de groeperingskolom.',
  'Samenvattingskolommen rechts van detail',
  'const LOGSKIP = 1',
  'const GSKIP = 1',
  'function mainFunction() {}',
  '"integrity": "sha512-abcGSK/Gsk+gsk0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyzABCDEF=="',
  'url(data:font/woff2;base64,d09GMgABGsk/gsk+GSK0AAAA)',
]

describe('check-no-genspark', () => {
  beforeEach(() => {
    repo = tempDir()
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })
  })

  it('reports every line that names the removed vendor', () => {
    commit({ 'src/found.ts': `${MATCHING.join('\n')}\n` })
    const r = check()
    expect(r.code).toBe(1)
    expect(reportedLines(r.stderr, 'src/found.ts')).toEqual(MATCHING.map((_, index) => index + 1))
  })

  it('reports the matched text with its file and line', () => {
    commit({ 'src/a.ts': 'const a = 1\nconst key = gskApiKey()\n' })
    const r = check()
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('  src/a.ts:2: gsk')
    expect(r.stderr).toMatch(/1 hit in 1 file/)
  })

  it('passes names that stay and words that merely contain the letters', () => {
    commit({ 'src/clean.ts': `${CLEAN.join('\n')}\n` })
    const r = check()
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^check-no-genspark: OK \(1 file scanned, 0 allowlisted hits\)\n$/)
  })

  it('scans the lockfile like any other file', () => {
    commit({
      'package-lock.json': '{\n  "node_modules/@genspark/cli": { "version": "1.4.2" }\n}\n',
    })
    const r = check()
    expect(r.code).toBe(1)
    expect(reportedLines(r.stderr, 'package-lock.json')).toEqual([2])
  })

  it('skips binary files, by extension and by content', () => {
    commit({
      'art/logo.png': 'genspark',
      'fixtures/sample.docx': 'genspark',
      'data/blob.dat': Buffer.concat([Buffer.from('genspark'), Buffer.from([0, 1, 2])]),
    })
    const r = check()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('0 files scanned')
  })

  it('reports a file or a folder named after the removed vendor, whatever the file holds', () => {
    commit({
      'src/genspark/login.ts': 'export const a = 1\n',
      'docs/gsk-setup.md': '# Setup\n',
      'art/Genspark-logo.png': 'not text',
      'src/GskAuthError.ts': 'export const b = 1\n',
      'data/mainfunc.dat': Buffer.from([0, 1, 2]),
    })
    const r = check()
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('  src/genspark/login.ts: path: genspark\n')
    expect(r.stderr).toContain('  docs/gsk-setup.md: path: gsk\n')
    expect(r.stderr).toContain('  art/Genspark-logo.png: path: Genspark\n')
    expect(r.stderr).toContain('  src/GskAuthError.ts: path: Gsk\n')
    expect(r.stderr).toContain('  data/mainfunc.dat: path: mainfunc\n')
    expect(r.stderr).toMatch(/5 hits in 5 files/)
  })

  it('reports a path once for each time it names the vendor, next to the hits inside the file', () => {
    commit({ 'genspark/genspark.ts': 'const key = gskApiKey()\n' })
    const r = check()
    expect(r.code).toBe(1)
    expect(r.stderr.match(/^ {2}genspark\/genspark\.ts: path: genspark$/gm)).toHaveLength(2)
    expect(reportedLines(r.stderr, 'genspark/genspark.ts')).toEqual([1])
    expect(r.stderr).toMatch(/3 hits in 1 file/)
  })

  it('passes paths that keep their name or merely contain the letters', () => {
    commit({
      'packages/genoffice-ai/src/genofficeAiSettings.ts': 'export const a = 1\n',
      'src/i18n/markeringskleur.ts': 'export const b = 1\n',
      'src/LOGSKIP.ts': 'export const c = 1\n',
      'src/mainFunction.ts': 'export const d = 1\n',
    })
    const r = check()
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('0 allowlisted hits')
  })

  it('applies the allowlist to a path as it does to a line: only this check keeps its name', () => {
    commit({
      'tools/check-no-genspark.mjs': 'export const a = 1\n',
      'packages/cli/tests/check-no-genspark.test.ts': 'export const b = 1\n',
    })
    const own = check()
    expect(own.stderr).toBe('')
    expect(own.code).toBe(0)
    expect(own.stdout).toContain('2 allowlisted hits')

    // an entry for a file's contents does not cover a differently named file
    commit({ 'tools/genspark-check.mjs': 'export const c = 1\n' })
    const other = check()
    expect(other.code).toBe(1)
    expect(other.stderr).toContain('  tools/genspark-check.mjs: path: genspark\n')
    expect(other.stderr).toMatch(/1 hit in 1 file/)
  })

  it('allows the licence files and counts what it let through', () => {
    commit({
      LICENSE: '   Copyright 2026 Mainfunc, Inc.\n',
      NOTICE:
        'Copyright 2026 Mainfunc, Inc.\nThe names GenOffice and Genspark belong to their owners.\n',
    })
    const r = check()
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('3 allowlisted hits')
  })

  it('allows a copyright notice inside any file, and nothing else on other lines', () => {
    commit({ 'src/vendor.ts': '// Copyright 2026 Mainfunc, Inc.\nconst owner = "Mainfunc"\n' })
    const r = check()
    expect(r.code).toBe(1)
    expect(reportedLines(r.stderr, 'src/vendor.ts')).toEqual([2])
    expect(r.stderr).toContain('1 allowlisted hit')
  })

  it('allows the acknowledgement section of the README and the link to the original, nothing else', () => {
    const readme = [
      '# Product',
      'A modified version of [GenOffice](https://github.com/genspark-ai/genoffice).',
      'Sign in to Genspark to start.',
      '## License and acknowledgement',
      'Based on GenOffice by Genspark (Mainfunc, Inc.).',
      '## Next section',
      'Genspark again.',
    ].join('\n')
    commit({ 'README.en.md': readme, 'docs/guide.md': readme })
    const r = check()
    expect(r.code).toBe(1)
    expect(reportedLines(r.stderr, 'README.en.md')).toEqual([3, 7])
    // the same text in another file is not covered by the README entries
    expect(reportedLines(r.stderr, 'docs/guide.md')).toEqual([2, 3, 5, 7])
  })

  it('allows the namespace written into documents only on its own line', () => {
    commit({
      'packages/agent-core/src/redact-range.ts': [
        "export const REDACT_NS = 'https://genspark.ai/genoffice/redaction/2026'",
        "export const OTHER = 'https://genspark.ai/other'",
      ].join('\n'),
    })
    const r = check()
    expect(r.code).toBe(1)
    expect(reportedLines(r.stderr, 'packages/agent-core/src/redact-range.ts')).toEqual([2])
  })

  it('allows the old ids in the settings migration fixture, but no other pattern there', () => {
    commit({
      'packages/ai-provider/tests/legacy-settings.test.ts': [
        "const file = { provider: 'genspark', gskToolsEnabled: false }",
        "const link = 'https://genoffice.ai/'",
      ].join('\n'),
    })
    const r = check()
    expect(r.code).toBe(1)
    expect(reportedLines(r.stderr, 'packages/ai-provider/tests/legacy-settings.test.ts')).toEqual([
      2,
    ])
  })
})
