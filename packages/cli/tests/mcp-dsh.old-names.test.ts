import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMcpEntry, removeMcpEntry, writeMcpEntry } from '../src/agent-mcp'

/**
 * The DSH Cordis block an earlier version wrote (`mcp-ieumoffice`, server
 * `ieumoffice`, our launcher) is this app's: listed as needing an update,
 * replaced by install (one block), removed by uninstall (none). A block under
 * the old name that starts another program stays another program's.
 */

const LAUNCH = {
  command: '/Applications/SeuOffice.app/Contents/Resources/cli/seuoffice',
  args: ['mcp'],
  env: undefined,
}
const dir = mkdtempSync(join(tmpdir(), 'mcp-dsh-old-'))

const block = (id: string, server: string, command: string) => [
  '- insert:',
  `  - id: ${id}`,
  "    name: '@deepseek-ai/dsh-mcp-client'",
  '    config:',
  `      serverName: ${server}`,
  '      transport: stdio',
  `      command: ${command}`,
  "      args: ['mcp']",
  '      toolCallTimeoutMs: 180000',
  '      failOnStartupError: false',
]
// as 0.12.37 wrote it on macOS
const OLD_BLOCK = block(
  'mcp-ieumoffice',
  'ieumoffice',
  '/Applications/SeuOffice.app/Contents/Resources/cli/ieumoffice',
)
const OTHER = block('mcp-other', 'other-server', '/usr/bin/other')
const blocksIn = (text: string) => (text.match(/^- insert:/gm) ?? []).length

describe('the DSH Cordis block an earlier version wrote', () => {
  it('reads as ours, written for another launcher: stale', () => {
    const file = join(dir, 'old.yml')
    writeFileSync(file, [...OLD_BLOCK, ''].join('\n'))
    expect(readMcpEntry('dsh', file, LAUNCH).status).toBe('stale')
  })

  it('is replaced by install, leaving one block of ours and the others as they were', () => {
    const file = join(dir, 'install.yml')
    writeFileSync(file, [...OTHER, ...OLD_BLOCK, ''].join('\n'))
    writeMcpEntry('dsh', file, LAUNCH)
    const text = readFileSync(file, 'utf-8')
    expect(text).not.toContain('mcp-ieumoffice')
    expect(text).toContain('id: mcp-seuoffice')
    expect(text).toContain('id: mcp-other')
    expect(blocksIn(text)).toBe(2)
    expect(readMcpEntry('dsh', file, LAUNCH).status).toBe('registered')
  })

  it('is removed by uninstall, together with a block a later install added beside it', () => {
    const file = join(dir, 'uninstall.yml')
    const current = block('mcp-seuoffice', 'seuoffice', LAUNCH.command)
    writeFileSync(file, [...OLD_BLOCK, ...OTHER, ...current, ''].join('\n'))
    expect(removeMcpEntry('dsh', file)).toBe(true)
    const text = readFileSync(file, 'utf-8')
    expect(text).not.toContain('mcp-ieumoffice')
    expect(text).not.toContain('mcp-seuoffice')
    expect(text).toContain('id: mcp-other')
    expect(readMcpEntry('dsh', file, LAUNCH).status).toBe('absent')
  })

  it('stays another program’s when it starts something else', () => {
    const file = join(dir, 'foreign.yml')
    const foreign = block('mcp-ieumoffice', 'ieumoffice', '/usr/local/bin/some-other-tool')
    writeFileSync(file, [...foreign, ''].join('\n'))
    expect(readMcpEntry('dsh', file, LAUNCH).status).toBe('absent')
    writeMcpEntry('dsh', file, LAUNCH)
    expect(readFileSync(file, 'utf-8')).toContain('/usr/local/bin/some-other-tool')
    expect(removeMcpEntry('dsh', file)).toBe(true)
    expect(readFileSync(file, 'utf-8')).toBe([...foreign, ''].join('\n'))
  })
})
