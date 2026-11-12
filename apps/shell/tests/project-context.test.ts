import { describe, expect, it } from 'vitest'
import { PROJECT_FOLDER_NAMES } from '@seuoffice/project-store'
import { assembleTrustedContext } from '../src/main/projects/context'
import { hashText } from '../src/main/projects/folder-files'

/** What one request carries for a trusted project (spec 5.4, 5.10) */

const { dataDir } = PROJECT_FOLDER_NAMES
const on = { memoryEnabled: true, readAgentsFiles: true }
const off = { memoryEnabled: true, readAgentsFiles: false }
const texts = (over: Partial<Record<'instructions' | 'memory' | 'agents' | 'claude', string>>) => ({
  dataDir,
  instructions: over.instructions ?? null,
  memory: over.memory ?? null,
  agents: over.agents ?? null,
  claude: over.claude ?? null,
})

describe('assembleTrustedContext', () => {
  it('names each instructions source on its own line, in a fixed order', () => {
    const result = assembleTrustedContext(
      texts({ instructions: 'mine', claude: 'claude', agents: 'agents' }),
      { decision: 'use', hashes: {} },
      on,
    )
    expect(result.instructions).toEqual({
      text: `[${dataDir}/instructions.md]\nmine\n\n[AGENTS.md]\nagents\n\n[CLAUDE.md]\nclaude`,
      sources: ['instructions', 'agents', 'claude'],
    })
  })

  it('carries the data folder the project uses, so the prompt can name its instructions file', () => {
    const result = assembleTrustedContext(
      { ...texts({ instructions: 'mine' }), dataDir: '.ieumoffice' },
      { decision: 'use', hashes: {} },
      on,
    )
    expect(result.instructions?.dataDir).toBe('.ieumoffice')
  })

  it('leaves out sources cut away entirely by the limit', () => {
    const result = assembleTrustedContext(
      texts({ instructions: 'x'.repeat(50), agents: 'agents' }),
      { decision: 'use', hashes: {} },
      on,
      40,
    )
    expect(result.instructions?.text.length).toBe(40)
    expect(result.instructions?.sources).toEqual(['instructions'])
    const full = `[${dataDir}/instructions.md]\n${'x'.repeat(50)}\n\n[AGENTS.md]\nagents`
    expect(result.notices).toContainEqual({
      kind: 'instructions-truncated',
      chars: full.length,
      limit: 40,
    })
  })

  it('never cuts memory; a long one gets a notice', () => {
    const memory = `<!-- h -->\n${'- fact\n'.repeat(20)}`
    const result = assembleTrustedContext(
      texts({ memory }),
      { decision: 'use', hashes: { memory: hashText(memory) } },
      on,
      100,
      50,
    )
    expect(result.memory).toEqual({ text: memory, chars: memory.length })
    expect(result.notices).toEqual([{ kind: 'memory-long', chars: memory.length, limit: 50 }])
  })

  it('treats a header-only memory as empty', () => {
    const result = assembleTrustedContext(
      texts({ memory: '<!-- h -->\n\n' }),
      { decision: 'use', hashes: {} },
      on,
    )
    expect(result.memory).toBeNull()
    expect(result.notices).toEqual([])
  })

  it('does not watch or send root agent files while they are switched off', () => {
    const result = assembleTrustedContext(
      texts({ agents: 'new agents' }),
      { decision: 'use', hashes: {} },
      off,
    )
    expect(result.instructions).toBeNull()
    expect(result.notices).toEqual([])
    expect(result.hashUpdates).toEqual({})
  })

  it('drops the hash of a file that is gone, without a notice', () => {
    const result = assembleTrustedContext(
      texts({}),
      { decision: 'use', hashes: { instructions: hashText('old') } },
      on,
    )
    expect(result.hashUpdates).toEqual({ instructions: null })
    expect(result.notices).toEqual([])
  })
})
